process.env.BUCKET_NAME = "test-bucket";
process.env.TABLE_NAME = "test-table";
process.env.PRIMARY_KEY = "pk";
process.env.SORT_KEY = "sk";
process.env.PK_VALUE = "BILL";
process.env.QUEUE_URL = "https://example.com/test-queue";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { handler } from "../handlers/createBillsManifest";
import { repairedDocument } from "../../scripts/repairFailedStatus";
import { finalizedDocument } from "../../scripts/repairFinalizedStatus";
import { billContentHash, formatDateBasis, manifestDateBasis } from "../shared/billVersionChange";
import { extractS3ObjectRefsFromSQSEvent } from "../shared/s3EventExtract";
import { asSqsEvent } from "./fixtures/awsEvents";
import { HELD_FOR_REVIEW_CASES } from "./fixtures/heldForReview";
import { CURATED_OVERRIDE_CASES } from "./fixtures/curatedCeremonialOverrides";
import { jsonReadable } from "./fixtures/streams";
import { applyTestEnv } from "./fixtures/env";
import { FakeVersionedS3, type FakeS3Command, type FakeS3Input } from "./fakeVersionedS3";

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  const mockSend = jest.fn();
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: "ListObjectsV2Command", input })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "HeadObjectCommand", input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
    ListObjectVersionsCommand: jest
      .fn()
      .mockImplementation((input) => ({ __type: "ListObjectVersionsCommand", input })),
  };
});

jest.mock("@aws-sdk/client-sqs", () => {
  const actual = jest.requireActual("@aws-sdk/client-sqs");
  const mockSend = jest.fn();
  return {
    ...actual,
    SQSClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
    DeleteItemCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteItemCommand", input })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
    TransactWriteItemsCommand: jest
      .fn()
      .mockImplementation((input) => ({ __type: "TransactWriteItemsCommand", input })),
  };
});

type Item = Record<string, AttributeValue>;
/** The table in memory: items by "pk|sk". */
type Items = Record<string, Item>;
/** A field a write names: a condition, an update, or the key and item it targets. */
interface WriteSpec {
  Key?: Item;
  Item?: Item;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}
interface TransactOp {
  Put?: WriteSpec;
  Delete?: WriteSpec;
  Update?: WriteSpec;
}
/** The input fields the DynamoDB fake reads and the tests assert on. */
interface DdbInput extends WriteSpec {
  TransactItems?: TransactOp[];
  Limit?: number;
}
interface DdbCommand {
  __type: string;
  input: DdbInput;
}
interface SqsEntry {
  Id: string;
  MessageBody: string;
}
interface SqsCommand {
  input: { QueueUrl: string; Entries: SqsEntry[] };
}
/** An S3 command the mocked client constructors return; the input fields the fakes read. */
interface S3Command {
  __type: string;
  input: FakeS3Input;
}
/** A processed bill document, the fields the tests read; others pass through. */
type BillDoc = {
  storedAt: string;
  title: string;
  subCategories: string[];
  lifeAreas: string[];
  sponsors: string[];
  cosponsors: string[];
  billStatus?: string;
  actions?: unknown[];
  [field: string]: unknown;
};
/** The handler and the three client mocks, loaded together in isolation. */
interface LoadedHandler {
  handler: typeof handler;
  s3Send: jest.Mock;
  sqsSend: jest.Mock;
  ddbSend: jest.Mock;
}
/** A DDB transaction the handler sent: every one carries its items. */
interface TransactCommand extends DdbCommand {
  input: DdbInput & { TransactItems: TransactOp[] };
}

/** A GetObject answer from the fake bucket: it carries a body that reads as a string. */
const hasBody = (response: object): response is { Body: { transformToString(): Promise<string> } } =>
  "Body" in response;

const ddbKey = (pk: string, sk: string) => `${pk}|${sk}`;

// Evaluates the small subset of condition expressions the handler writes:
// clauses joined by AND, each attribute_exists(#a), attribute_not_exists(#a) or #a = :v.
const evaluateCondition = (item: Item | undefined, spec: WriteSpec | undefined): boolean => {
  const expression = spec?.ConditionExpression;
  if (!expression) return true;
  const names = spec.ExpressionAttributeNames ?? {};
  const values = spec.ExpressionAttributeValues ?? {};
  return expression.split(/\s+AND\s+/i).every((clause: string) => {
    const trimmed = clause.trim();
    let match = trimmed.match(/^attribute_not_exists\((#\w+)\)$/);
    if (match) return item?.[names[match[1]]] === undefined;
    match = trimmed.match(/^attribute_exists\((#\w+)\)$/);
    if (match) return item?.[names[match[1]]] !== undefined;
    match = trimmed.match(/^(#\w+)\s*=\s*(:\w+)$/);
    if (match) return JSON.stringify(item?.[names[match[1]]]) === JSON.stringify(values[match[2]]);
    throw new Error("Unsupported condition in test mock: " + trimmed);
  });
};

// Applies the small subset of update expressions the handler writes: "SET #a = :v, #b = if_not_exists(#b, :w)".
const applyUpdate = (item: Item | undefined, spec: WriteSpec): Item => {
  const names = spec.ExpressionAttributeNames ?? {};
  const values = spec.ExpressionAttributeValues ?? {};
  const next = { ...(item ?? {}), ...spec.Key };
  const expression = spec.UpdateExpression ?? "";
  if (!expression.startsWith("SET ")) throw new Error("Unsupported update in test mock: " + expression);
  for (const clause of expression.slice(4).split(/,\s*(?![^(]*\))/)) {
    let match = clause.trim().match(/^(#\w+)\s*=\s*(:\w+)$/);
    if (match) {
      next[names[match[1]]] = values[match[2]];
      continue;
    }
    match = clause.trim().match(/^(#\w+)\s*=\s*if_not_exists\((#\w+),\s*(:\w+)\)$/);
    if (!match) throw new Error("Unsupported update clause in test mock: " + clause);
    next[names[match[1]]] = item?.[names[match[2]]] ?? values[match[3]];
  }
  return next;
};

const transactionCanceled = (codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

// Helper: build a DDB mock that tracks items by composite key.
const buildDdbMock = (ddbItems: Items) => (cmd: DdbCommand) => {
  const input = cmd.input || {};
  if (cmd.__type === "GetItemCommand") {
    const pk = input.Key?.pk?.S;
    const sk = input.Key?.sk?.S;
    if (!pk || !sk) throw new Error("Missing PK/SK on GetItem");
    return { Item: ddbItems[ddbKey(pk, sk)] };
  }
  if (cmd.__type === "PutItemCommand") {
    const pk = input.Item?.pk?.S;
    const sk = input.Item?.sk?.S;
    if (!pk || !sk) throw new Error("Missing PK/SK on PutItem");
    ddbItems[ddbKey(pk, sk)] = input.Item!;
    return {};
  }
  if (cmd.__type === "DeleteItemCommand") {
    const pk = input.Key?.pk?.S;
    const sk = input.Key?.sk?.S;
    if (!pk || !sk) throw new Error("Missing PK/SK on DeleteItem");
    delete ddbItems[ddbKey(pk, sk)];
    return {};
  }
  if (cmd.__type === "TransactWriteItemsCommand") {
    const ops = input.TransactItems ?? [];
    const keys = ops.map((op) => {
      const key = op.Put ? op.Put.Item : (op.Delete?.Key ?? op.Update?.Key);
      if (!key?.pk?.S || !key?.sk?.S) throw new Error("Missing PK/SK in transaction item");
      return ddbKey(key.pk.S, key.sk.S);
    });
    if (new Set(keys).size !== keys.length) {
      throw Object.assign(new Error("Transaction request cannot include multiple operations on one item"), {
        name: "ValidationException",
      });
    }
    const codes = ops.map((op, idx) =>
      evaluateCondition(ddbItems[keys[idx]], op.Put ?? op.Delete ?? op.Update) ? "None" : "ConditionalCheckFailed",
    );
    if (codes.some((code) => code !== "None")) throw transactionCanceled(codes);
    ops.forEach((op, idx) => {
      if (op.Put) ddbItems[keys[idx]] = op.Put.Item!;
      else if (op.Update) ddbItems[keys[idx]] = applyUpdate(ddbItems[keys[idx]], op.Update);
      else delete ddbItems[keys[idx]];
    });
    return {};
  }
  if (cmd.__type === "QueryCommand") {
    const pkName = input.ExpressionAttributeNames?.["#pk"] ?? "pk";
    const skName = input.ExpressionAttributeNames?.["#sk"] ?? "sk";
    const lookupPk = input.ExpressionAttributeValues?.[":lookupPk"]?.S;
    const guidPrefix = input.ExpressionAttributeValues?.[":guidPrefix"]?.S ?? "";
    const items = Object.values(ddbItems).filter((item) => {
      const pk = item?.[pkName]?.S;
      const sk = item?.[skName]?.S;
      return pk === lookupPk && typeof sk === "string" && sk.startsWith(guidPrefix);
    });
    const limit = typeof input.Limit === "number" ? input.Limit : items.length;
    return { Items: items.slice(0, limit) };
  }
  throw new Error("Unexpected DDB request: " + cmd.__type + " " + JSON.stringify(input));
};

describe("createBillsManifest handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-s3");
  const { __mockSend: mockSqsSend } = jest.requireMock("@aws-sdk/client-sqs");
  const { __mockSend: mockDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      TABLE_NAME: "test-table",
      PRIMARY_KEY: "pk",
      SORT_KEY: "sk",
      PK_VALUE: "BILL",
      QUEUE_URL: "https://example.com/test-queue",
      CONGRESS_MEMBER_STATS_QUEUE_URL: undefined,
    });

    mockSqsSend.mockImplementation((cmd: SqsCommand) => {
      const input = cmd.input || {};
      if (!input.QueueUrl || !Array.isArray(input.Entries)) {
        throw new Error("Unexpected SQS request: " + JSON.stringify(input));
      }
      return { Successful: input.Entries.map((e: SqsEntry) => ({ Id: e.Id })), Failed: [] };
    });
  });

  afterEach(() => {
    restoreEnv?.();
    jest.useRealTimers();
  });

  it("applies add/update from SQS-wrapped S3 event (manifest missing)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const billA = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2025-12-31T09:15:00.000Z",
      identifier: { congress: "108", billType: "senate-bill", billNumber: "922" },
      guid: "BILLS-108s922",
      title: "Naturalization Act",
      link: "https://www.congress.gov/bill/108th-congress/senate-bill/922",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["A123"],
      cosponsors: ["C001"],
    };

    const streamA = jsonReadable(billA);

    const { setupS3MockRequestAware } = require("./s3RequestMock");

    const ddbItems: Items = {};

    setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
      const input = cmd.input || {};
      const name =
        cmd.__type ||
        (input.Body
          ? "PutObjectCommand"
          : input.Key
            ? "GetObjectCommand"
            : Object.prototype.hasOwnProperty.call(input, "Prefix")
              ? "ListObjectsV2Command"
              : "Unknown");
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      if (name === "GetObjectCommand" && input.Key === "processed-bills/BILLS-108s922.json") {
        return { Body: streamA, LastModified: new Date().toISOString() };
      }
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            Records: [{ s3: { object: { key: "processed-bills/BILLS-108s922.json" } } }],
          }),
        },
      ],
    };

    const res = await handler(asSqsEvent(sqsEvent));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.addedOrUpdated).toBe(1);
    expect(body.deleted).toBe(0);
    expect(body.enqueued).toBe(1);

    const items = Object.values(ddbItems);
    expect(items).toHaveLength(2);
    const manifestItems = items.filter((item: Item) => item.pk?.S === "BILL");
    expect(manifestItems).toHaveLength(1);
    const lookupItems = items.filter((item: Item) => item.pk?.S === "BILL_GUID");
    expect(lookupItems).toHaveLength(1);
    const stored = manifestItems[0];
    expect(stored.guid.S).toBe("BILLS-108s922");
    expect(stored.updatedAt.S).toBe("2025-12-31T09:15:00.000Z");
    expect(stored.pk.S).toBe("BILL");
    expect(stored.sk.S).toBe("2025-12-31T09:15:00.000Z#BILLS-108s922");
    expect(stored.voteCount.N).toBe("0");
    expect(lookupItems[0].manifestSk.S).toBe("2025-12-31T09:15:00.000Z#BILLS-108s922");

    const sqsCall = mockSqsSend.mock.calls[0]?.[0]?.input;
    expect(sqsCall.QueueUrl).toBe("https://example.com/test-queue");
    expect(sqsCall.Entries).toHaveLength(1);
    const msg = JSON.parse(sqsCall.Entries[0].MessageBody);
    expect(msg.guid).toBeUndefined();
    expect(msg.updatedAt).toBeUndefined();
    expect(msg.Records[0].s3.bucket.name).toBe("test-bucket");
    expect(msg.Records[0].s3.object.key).toBe("processed-bills/BILLS-108s922.json");
  });

  it("deletes old SK and inserts new SK when manifest exists", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    // An action after the row's date: news, so the row moves (a version without any keeps its date, RUNBOOK 4.9).
    const billUpdated = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-05T10:30:00.000Z",
      identifier: { congress: "108", billType: "senate-bill", billNumber: "922" },
      guid: "BILLS-108s922",
      title: "Naturalization Act",
      link: "https://www.congress.gov/bill/108th-congress/senate-bill/922",
      actions: [{ actionDate: "2026-01-04", text: "Passed Senate without amendment by Unanimous Consent." }],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["A123"],
      cosponsors: ["C001"],
    };

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    const oldSk = "2026-01-01T00:00:00.000Z#BILLS-108s922";
    const ddbItems: Items = {
      [ddbKey("BILL", oldSk)]: {
        pk: { S: "BILL" },
        sk: { S: oldSk },
        guid: { S: "BILLS-108s922" },
        billType: { S: "senate-bill" },
        congress: { S: "108" },
        billNumber: { S: "922" },
        updatedAt: { S: "2026-01-01T00:00:00.000Z" },
        title: { S: "Old Title" },
        subCategories: { L: [{ S: "Old" }] },
        lifeAreas: { L: [{ S: "Old" }] },
        sponsors: { L: [{ S: "A123" }] },
        cosponsors: { L: [{ S: "C001" }] },
        voteCount: { N: "42" },
      },
      [ddbKey("BILL_GUID", "BILLS-108s922")]: {
        pk: { S: "BILL_GUID" },
        sk: { S: "BILLS-108s922" },
        guid: { S: "BILLS-108s922" },
        manifestSk: { S: oldSk },
        updatedAt: { S: "2026-01-01T00:00:00.000Z" },
      },
    };

    setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
      const input = cmd.input || {};
      const name =
        cmd.__type ||
        (input.Body
          ? "PutObjectCommand"
          : input.Key
            ? "GetObjectCommand"
            : Object.prototype.hasOwnProperty.call(input, "Prefix")
              ? "ListObjectsV2Command"
              : "Unknown");
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      if (name === "GetObjectCommand" && input.Key === "processed-bills/BILLS-108s922.json") {
        return { Body: jsonReadable(billUpdated) };
      }
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({ Records: [{ s3: { object: { key: "processed-bills/BILLS-108s922.json" } } }] }),
        },
      ],
    };

    const res = await handler(asSqsEvent(sqsEvent));
    expect(res.statusCode).toBe(200);

    const items = Object.values(ddbItems);
    expect(items).toHaveLength(2);
    const stored = items.find((item: Item) => item.pk?.S === "BILL");
    expect(stored!.title.S).toBe("Naturalization Act");
    expect(stored!.updatedAt.S).toBe("2026-01-05T10:30:00.000Z");
    expect(stored!.sk.S).toBe("2026-01-05T10:30:00.000Z#BILLS-108s922");
    expect(stored!.voteCount.N).toBe("42");
    // Old SK should be gone
    expect(ddbItems[ddbKey("BILL", oldSk)]).toBeUndefined();
    const lookup = items.find((item: Item) => item.pk?.S === "BILL_GUID");
    expect(lookup!.manifestSk.S).toBe("2026-01-05T10:30:00.000Z#BILLS-108s922");
  });

  it("rewrites manifest row when bill status changes but updatedAt stays the same", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const billUpdated = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-05T10:30:00.000Z",
      identifier: { congress: "108", billType: "senate-bill", billNumber: "922" },
      guid: "BILLS-108s922",
      title: "Naturalization Act",
      link: "https://www.congress.gov/bill/108th-congress/senate-bill/922",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["A123"],
      cosponsors: ["C001"],
      billStatus: "Failed",
    };

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    const existingSk = "2026-01-05T10:30:00.000Z#BILLS-108s922";
    const ddbItems: Items = {
      [ddbKey("BILL", existingSk)]: {
        pk: { S: "BILL" },
        sk: { S: existingSk },
        guid: { S: "BILLS-108s922" },
        billType: { S: "senate-bill" },
        congress: { S: "108" },
        billNumber: { S: "922" },
        updatedAt: { S: "2026-01-05T10:30:00.000Z" },
        title: { S: "Naturalization Act" },
        subCategories: { L: [{ S: "Healthcare" }] },
        lifeAreas: { L: [{ S: "Taxes" }] },
        sponsors: { L: [{ S: "A123" }] },
        cosponsors: { L: [{ S: "C001" }] },
        voteCount: { N: "42" },
        billStatus: { S: "New" },
      },
      [ddbKey("BILL_GUID", "BILLS-108s922")]: {
        pk: { S: "BILL_GUID" },
        sk: { S: "BILLS-108s922" },
        guid: { S: "BILLS-108s922" },
        manifestSk: { S: existingSk },
        updatedAt: { S: "2026-01-05T10:30:00.000Z" },
      },
    };

    setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
      const input = cmd.input || {};
      const name =
        cmd.__type ||
        (input.Body
          ? "PutObjectCommand"
          : input.Key
            ? "GetObjectCommand"
            : Object.prototype.hasOwnProperty.call(input, "Prefix")
              ? "ListObjectsV2Command"
              : "Unknown");
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      if (name === "GetObjectCommand" && input.Key === "processed-bills/BILLS-108s922.json") {
        return { Body: jsonReadable(billUpdated) };
      }
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({ Records: [{ s3: { object: { key: "processed-bills/BILLS-108s922.json" } } }] }),
        },
      ],
    };

    const res = await handler(asSqsEvent(sqsEvent));
    expect(res.statusCode).toBe(200);

    const stored = ddbItems[ddbKey("BILL", existingSk)];
    expect(stored).toBeDefined();
    expect(stored.voteCount.N).toBe("42");
    expect(stored.billStatus.S).toBe("Failed");

    const lookup = ddbItems[ddbKey("BILL_GUID", "BILLS-108s922")];
    expect(lookup.manifestSk.S).toBe(existingSk);
  });

  it("removes entries for ObjectRemoved events", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    const sk = "2026-01-01T00:00:00.000Z#BILLS-108s922is";
    const ddbItems: Items = {
      [ddbKey("BILL", sk)]: {
        pk: { S: "BILL" },
        sk: { S: sk },
        guid: { S: "BILLS-108s922is" },
        billType: { S: "senate-bill" },
        congress: { S: "108" },
        billNumber: { S: "922" },
        updatedAt: { S: "2026-01-01T00:00:00.000Z" },
        title: { S: "Naturalization Act" },
        subCategories: { L: [] },
        lifeAreas: { L: [] },
        sponsors: { L: [] },
        cosponsors: { L: [] },
      },
      [ddbKey("BILL_GUID", "BILLS-108s922is")]: {
        pk: { S: "BILL_GUID" },
        sk: { S: "BILLS-108s922is" },
        guid: { S: "BILLS-108s922is" },
        manifestSk: { S: sk },
        updatedAt: { S: "2026-01-01T00:00:00.000Z" },
      },
    };

    setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
      const input = cmd.input || {};
      const name =
        cmd.__type ||
        (input.Body
          ? "PutObjectCommand"
          : input.Key
            ? "GetObjectCommand"
            : Object.prototype.hasOwnProperty.call(input, "Prefix")
              ? "ListObjectsV2Command"
              : "Unknown");
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      if (name === "GetObjectCommand" && input.Key?.startsWith("processed-bills/"))
        throw new Error("Should not GET processed object on remove");
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            Records: [
              { eventName: "ObjectRemoved:Delete", s3: { object: { key: "processed-bills/BILLS-108s922.json" } } },
            ],
          }),
        },
      ],
    };

    const res = await handler(asSqsEvent(sqsEvent));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(ddbItems)).toHaveLength(0);
    const body = JSON.parse(res.body);
    expect(body.addedOrUpdated).toBe(0);
    expect(body.deleted).toBe(1);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it("ignores events for non-processed-bills keys", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
      const input = cmd.input || {};
      const name = cmd.__type;
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: DdbCommand) => {
      const input = cmd.input || {};
      if (cmd.__type === "PutItemCommand") {
        throw new Error("Should not write bill items for non-processed-bills keys");
      }
      if (cmd.__type === "DeleteItemCommand") {
        throw new Error("Should not delete bill items for non-processed-bills keys");
      }
      throw new Error("Unexpected DDB request: " + cmd.__type + " " + JSON.stringify(input));
    });

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            Records: [{ s3: { object: { key: "bills-manifest.json" } } }],
          }),
        },
      ],
    };

    const res = await handler(asSqsEvent(sqsEvent));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).updated).toBe(false);
    expect(JSON.parse(res.body).addedOrUpdated).toBe(0);
    expect(JSON.parse(res.body).deleted).toBe(0);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  describe("per-record failures (M1)", () => {
    const recordFor = (messageId: string, key: string) => ({
      messageId,
      body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }),
    });

    const serve = (bodies: Record<string, string>) => {
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
        const key = cmd.input.Key!;
        if (cmd.__type === "GetObjectCommand" && key in bodies) {
          const { Readable } = require("stream");
          return { Body: Readable.from([Buffer.from(bodies[key])]) };
        }
        throw new Error("Unexpected S3 request: " + cmd.__type + " " + JSON.stringify(cmd.input));
      });
    };

    const bill = (guid: string, billNumber: string) =>
      JSON.stringify({
        kind: "processed",
        storedAt: "2026-01-05T10:30:00.000Z",
        identifier: { congress: "119", billType: "house-bill", billNumber },
        guid,
        title: `Bill ${billNumber}`,
      });

    beforeEach(() => {
      jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("fails only the record whose processed bill cannot be parsed and forwards only the good ones", async () => {
      const ddbItems: Items = {};
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));
      serve({
        "processed-bills/BILLS-119hr1.json": bill("BILLS-119hr1", "1"),
        "processed-bills/BILLS-119hr2.json": "{not json",
        "processed-bills/BILLS-119hr3.json": bill("BILLS-119hr3", "3"),
      });

      const res = await handler(
        asSqsEvent({
          Records: [
            recordFor("m1", "processed-bills/BILLS-119hr1.json"),
            recordFor("m2", "processed-bills/BILLS-119hr2.json"),
            recordFor("m3", "processed-bills/BILLS-119hr3.json"),
          ],
        }),
      );

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m2" }]);
      const body = JSON.parse(res.body);
      expect(body.addedOrUpdated).toBe(2);
      expect(body.failedRecords).toBe(1);
      expect(body.stats.addFetchFailed).toBe(1);
      expect(ddbItems[ddbKey("BILL_GUID", "BILLS-119hr1")]).toBeDefined();
      expect(ddbItems[ddbKey("BILL_GUID", "BILLS-119hr3")]).toBeDefined();

      const forwardedKeys = mockSqsSend.mock.calls.flatMap(([cmd]: [SqsCommand]) =>
        cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody).Records[0].s3.object.key),
      );
      expect(forwardedKeys).toEqual(["processed-bills/BILLS-119hr1.json", "processed-bills/BILLS-119hr3.json"]);
    });

    it("fails a record whose forward fails, after its manifest write", async () => {
      const ddbItems: Items = {};
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));
      serve({ "processed-bills/BILLS-119hr1.json": bill("BILLS-119hr1", "1") });
      mockSqsSend.mockImplementationOnce(() => {
        throw new Error("SQS unavailable");
      });

      const res = await handler(asSqsEvent({ Records: [recordFor("m1", "processed-bills/BILLS-119hr1.json")] }));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
      expect(ddbItems[ddbKey("BILL_GUID", "BILLS-119hr1")]).toBeDefined();
    });

    it("forwards a key once when two records in the batch carry it", async () => {
      mockDdbSend.mockImplementation(buildDdbMock({}));
      serve({ "processed-bills/BILLS-119hr1.json": bill("BILLS-119hr1", "1") });

      const res = await handler(
        asSqsEvent({
          Records: [
            recordFor("m1", "processed-bills/BILLS-119hr1.json"),
            recordFor("m2", "processed-bills/BILLS-119hr1.json"),
          ],
        }),
      );

      expect(res.batchItemFailures).toEqual([]);
      expect(JSON.parse(res.body).enqueued).toBe(1);
      expect(mockSqsSend).toHaveBeenCalledTimes(1);
    });

    it("returns an empty batchItemFailures list when nothing applies", async () => {
      const res = await handler(asSqsEvent({ Records: [recordFor("m1", "bills-manifest.json")] }));
      expect(res.batchItemFailures).toEqual([]);
    });
  });

  describe("atomic upsert (REL-08)", () => {
    const guid = "BILLS-108s922";
    const oldSk = "2026-01-01T00:00:00.000Z#BILLS-108s922";
    const newSk = "2026-01-05T10:30:00.000Z#BILLS-108s922";
    const updateEvent = {
      Records: [
        {
          messageId: "m-update",
          body: JSON.stringify({ Records: [{ s3: { object: { key: "processed-bills/BILLS-108s922.json" } } }] }),
        },
      ],
    };

    const seedExisting = (voteCount = "42", rowGuid = guid): Items => {
      const sk = `2026-01-01T00:00:00.000Z#${rowGuid}`;
      return {
        [ddbKey("BILL", sk)]: {
          pk: { S: "BILL" },
          sk: { S: sk },
          guid: { S: rowGuid },
          billType: { S: "senate-bill" },
          title: { S: "Old Title" },
          updatedAt: { S: "2026-01-01T00:00:00.000Z" },
          voteCount: { N: voteCount },
        },
        [ddbKey("BILL_GUID", rowGuid)]: {
          pk: { S: "BILL_GUID" },
          sk: { S: rowGuid },
          guid: { S: rowGuid },
          manifestSk: { S: sk },
          updatedAt: { S: "2026-01-01T00:00:00.000Z" },
        },
      };
    };

    // The document has an action after the row's date, so the row moves (RUNBOOK 4.9).
    const serveBill = (storedAt = "2026-01-05T10:30:00.000Z", documentGuid = guid) => {
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, (cmd: S3Command) => {
        const input = cmd.input || {};
        if (cmd.__type === "GetObjectCommand" && input.Key === "processed-bills/BILLS-108s922.json") {
          return {
            Body: jsonReadable({
              kind: "processed",
              storedAt,
              identifier: { congress: "108", billType: "senate-bill", billNumber: "922" },
              guid: documentGuid,
              title: "Naturalization Act",
              actions: [{ actionDate: "2026-01-04", text: "Passed Senate without amendment by Unanimous Consent." }],
              subCategories: [],
              lifeAreas: [],
              sponsors: [],
              cosponsors: [],
            }),
          };
        }
        throw new Error("Unexpected S3 request: " + cmd.__type + " " + JSON.stringify(input));
      });
    };

    const transactCalls = () =>
      (mockDdbSend.mock.calls as Array<[DdbCommand]>).filter(
        ([cmd]) => cmd.__type === "TransactWriteItemsCommand",
      ) as Array<[TransactCommand]>;

    beforeEach(() => {
      jest.spyOn(Math, "random").mockReturnValue(0); // zero retry backoff
      jest.spyOn(console, "warn").mockImplementation(() => undefined);
      jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("moves the row with one conditional transaction and no standalone writes", async () => {
      const ddbItems = seedExisting();
      serveBill();
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

      const res = await handler(asSqsEvent(updateEvent));
      expect(JSON.parse(res.body).addedOrUpdated).toBe(1);

      const standaloneWrites = mockDdbSend.mock.calls.filter(
        ([cmd]: [DdbCommand]) => cmd.__type === "PutItemCommand" || cmd.__type === "DeleteItemCommand",
      );
      expect(standaloneWrites).toHaveLength(0);

      expect(transactCalls()).toHaveLength(1);
      const [deleteOld, putNew, putLookup] = transactCalls()[0][0].input.TransactItems;
      expect(deleteOld.Delete).toMatchObject({
        Key: { pk: { S: "BILL" }, sk: { S: oldSk } },
        ConditionExpression:
          "#voteCount = :observedVoteCount AND attribute_not_exists(#computedFrom) AND " +
          "attribute_not_exists(#contentHash) AND attribute_not_exists(#dateBasis) AND " +
          "attribute_not_exists(#documentStoredAt)",
        ExpressionAttributeNames: {
          "#voteCount": "voteCount",
          "#computedFrom": "voteCountComputedFrom",
          "#contentHash": "contentHash",
          "#dateBasis": "dateBasis",
          "#documentStoredAt": "documentStoredAt",
        },
        ExpressionAttributeValues: { ":observedVoteCount": { N: "42" } },
      });
      expect(putNew.Put!.Item).toMatchObject({
        sk: { S: newSk },
        voteCount: { N: "42" },
        documentStoredAt: { S: "2026-01-05T10:30:00.000Z" },
      });
      expect(putNew.Put!.ConditionExpression).toBeUndefined();
      expect(putLookup.Put).toMatchObject({
        Item: { pk: { S: "BILL_GUID" }, manifestSk: { S: newSk } },
        ConditionExpression: "#manifestSk = :expectedManifestSk",
        ExpressionAttributeValues: { ":expectedManifestSk": { S: oldSk } },
      });
    });

    it("keys a document stored with a suffixed guid by its key's plain guid: no second row or lookup", async () => {
      const ddbItems = seedExisting();
      serveBill("2026-01-05T10:30:00.000Z", "BILLS-108s922is");
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

      const res = await handler(asSqsEvent(updateEvent));

      expect(JSON.parse(res.body).addedOrUpdated).toBe(1);
      expect(transactCalls()).toHaveLength(1);
      const [deleteOld, putNew, putLookup] = transactCalls()[0][0].input.TransactItems;
      expect(deleteOld.Delete!.Key).toEqual({ pk: { S: "BILL" }, sk: { S: oldSk } });
      expect(putNew.Put!.Item).toMatchObject({ sk: { S: newSk }, guid: { S: guid }, voteCount: { N: "42" } });
      expect(putLookup.Put!.Item).toMatchObject({ sk: { S: guid }, guid: { S: guid }, manifestSk: { S: newSk } });
      const puts = transactCalls().flatMap(([cmd]) => cmd.input.TransactItems.filter((item: TransactOp) => item.Put));
      expect(puts.filter((item: TransactOp) => item.Put!.Item!.sk.S === "BILLS-108s922is")).toEqual([]);
      expect(Object.keys(ddbItems).sort()).toEqual([ddbKey("BILL", newSk), ddbKey("BILL_GUID", guid)].sort());
    });

    it("re-reads and keeps a vote count written between the read and the transaction", async () => {
      const ddbItems = seedExisting("42");
      serveBill();
      const base = buildDdbMock(ddbItems);
      let raced = false;
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          // billStatsAggregator lands a new count on the old row first.
          ddbItems[ddbKey("BILL", oldSk)] = { ...ddbItems[ddbKey("BILL", oldSk)], voteCount: { N: "43" } };
        }
        return base(cmd);
      });

      const res = await handler(asSqsEvent(updateEvent));
      expect(res.statusCode).toBe(200);
      expect(transactCalls()).toHaveLength(2);
      expect(ddbItems[ddbKey("BILL", oldSk)]).toBeUndefined();
      expect(ddbItems[ddbKey("BILL", newSk)].voteCount.N).toBe("43");
      expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk.S).toBe(newSk);
    });

    it("carries voteCountComputedFrom with the count and re-reads when a recompute changed it", async () => {
      const ddbItems = seedExisting("42");
      ddbItems[ddbKey("BILL", oldSk)].voteCountComputedFrom = { S: "2026-01-04T00:00:00.000Z" };
      serveBill();
      const base = buildDdbMock(ddbItems);
      let raced = false;
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          // A later recompute stores the same count: only voteCountComputedFrom moves.
          ddbItems[ddbKey("BILL", oldSk)] = {
            ...ddbItems[ddbKey("BILL", oldSk)],
            voteCountComputedFrom: { S: "2026-01-05T09:00:00.000Z" },
          };
        }
        return base(cmd);
      });

      const res = await handler(asSqsEvent(updateEvent));

      expect(res.statusCode).toBe(200);
      expect(transactCalls()).toHaveLength(2);
      expect(transactCalls()[0][0].input.TransactItems[0].Delete).toMatchObject({
        ConditionExpression:
          "#voteCount = :observedVoteCount AND #computedFrom = :observedComputedFrom AND " +
          "attribute_not_exists(#contentHash) AND attribute_not_exists(#dateBasis) AND " +
          "attribute_not_exists(#documentStoredAt)",
        ExpressionAttributeValues: {
          ":observedVoteCount": { N: "42" },
          ":observedComputedFrom": { S: "2026-01-04T00:00:00.000Z" },
        },
      });
      expect(ddbItems[ddbKey("BILL", newSk)]).toMatchObject({
        voteCount: { N: "42" },
        voteCountComputedFrom: { S: "2026-01-05T09:00:00.000Z" },
      });
      const reads = mockDdbSend.mock.calls
        .map(([cmd]: [DdbCommand]) => cmd)
        .filter((cmd: DdbCommand) => cmd.__type === "GetItemCommand" && cmd.input.Key!.pk.S === "BILL");
      expect(reads[0].input).toMatchObject({
        ProjectionExpression:
          "voteCount, #computedFrom, #updatedAt, #billStatus, #contentHash, #dateBasis, #documentStoredAt",
        ExpressionAttributeNames: {
          "#computedFrom": "voteCountComputedFrom",
          "#updatedAt": "updatedAt",
          "#billStatus": "billStatus",
          "#contentHash": "contentHash",
          "#dateBasis": "dateBasis",
          "#documentStoredAt": "documentStoredAt",
        },
        ConsistentRead: true,
      });
    });

    it("keeps the count when the sort key is unchanged by conditioning the in-place put", async () => {
      const ddbItems = seedExisting("7");
      // Same snapshot time as the existing row, so the row is rewritten in place.
      serveBill("2026-01-01T00:00:00.000Z");
      const base = buildDdbMock(ddbItems);
      let raced = false;
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          ddbItems[ddbKey("BILL", oldSk)] = { ...ddbItems[ddbKey("BILL", oldSk)], voteCount: { N: "8" } };
        }
        return base(cmd);
      });

      await handler(asSqsEvent(updateEvent));
      const firstAttempt = transactCalls()[0][0].input.TransactItems;
      expect(firstAttempt).toHaveLength(2);
      expect(firstAttempt[0].Put!.ConditionExpression).toBe(
        "#voteCount = :observedVoteCount AND attribute_not_exists(#computedFrom) AND " +
          "attribute_not_exists(#contentHash) AND attribute_not_exists(#dateBasis) AND " +
          "attribute_not_exists(#documentStoredAt)",
      );
      expect(ddbItems[ddbKey("BILL", oldSk)].voteCount.N).toBe("8");
      expect(ddbItems[ddbKey("BILL", oldSk)].title.S).toBe("Naturalization Act");
    });

    it("skips on retry when a concurrent writer already stored a newer snapshot", async () => {
      const ddbItems = seedExisting();
      serveBill();
      const newerSk = "2026-02-01T00:00:00.000Z#BILLS-108s922is";
      const base = buildDdbMock(ddbItems);
      let raced = false;
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          const oldRow = ddbItems[ddbKey("BILL", oldSk)];
          delete ddbItems[ddbKey("BILL", oldSk)];
          ddbItems[ddbKey("BILL", newerSk)] = { ...oldRow, sk: { S: newerSk } };
          ddbItems[ddbKey("BILL_GUID", guid)] = { ...ddbItems[ddbKey("BILL_GUID", guid)], manifestSk: { S: newerSk } };
        }
        return base(cmd);
      });

      const res = await handler(asSqsEvent(updateEvent));
      const body = JSON.parse(res.body);
      expect(body.stats.upsertsSkipped).toBe(1);
      expect(body.stats.upsertsSucceeded).toBe(0);
      expect(ddbItems[ddbKey("BILL", newSk)]).toBeUndefined();
      expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk.S).toBe(newerSk);
    });

    it("reports the record as failed after repeated conflicts without losing the stored count", async () => {
      const ddbItems = seedExisting("10");
      serveBill();
      const base = buildDdbMock(ddbItems);
      let count = 10;
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand") {
          count += 1;
          ddbItems[ddbKey("BILL", oldSk)] = { ...ddbItems[ddbKey("BILL", oldSk)], voteCount: { N: String(count) } };
        }
        return base(cmd);
      });

      const res = await handler(asSqsEvent(updateEvent));
      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-update" }]);
      expect(transactCalls()).toHaveLength(3);
      expect(ddbItems[ddbKey("BILL", oldSk)].voteCount.N).toBe("13");
      expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk.S).toBe(oldSk);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it("does not retry a transaction failure that is not a condition or conflict", async () => {
      const ddbItems = seedExisting();
      serveBill();
      const base = buildDdbMock(ddbItems);
      mockDdbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand") throw transactionCanceled(["ValidationError", "None", "None"]);
        return base(cmd);
      });

      const res = await handler(asSqsEvent(updateEvent));
      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-update" }]);
      expect(transactCalls()).toHaveLength(1);
    });

    it("removes the manifest row and its lookup in one transaction", async () => {
      // A legacy row and lookup keyed by the suffixed guid, found through the plain guid's prefix.
      const legacyGuid = "BILLS-108s922is";
      const ddbItems = seedExisting("42", legacyGuid);
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));

      const res = await handler(
        asSqsEvent({
          Records: [
            {
              body: JSON.stringify({
                Records: [
                  { eventName: "ObjectRemoved:Delete", s3: { object: { key: "processed-bills/BILLS-108s922.json" } } },
                ],
              }),
            },
          ],
        }),
      );

      expect(JSON.parse(res.body).deleted).toBe(1);
      expect(Object.keys(ddbItems)).toHaveLength(0);
      expect(transactCalls()).toHaveLength(1);
      expect(transactCalls()[0][0].input.TransactItems).toEqual([
        {
          Delete: {
            TableName: "test-table",
            Key: { pk: { S: "BILL" }, sk: { S: `2026-01-01T00:00:00.000Z#${legacyGuid}` } },
          },
        },
        { Delete: { TableName: "test-table", Key: { pk: { S: "BILL_GUID" }, sk: { S: legacyGuid } } } },
        // The event key is the normalized guid, so its (absent) lookup row is cleared too, as before.
        { Delete: { TableName: "test-table", Key: { pk: { S: "BILL_GUID" }, sk: { S: "BILLS-108s922" } } } },
      ]);
    });
  });

  describe("rows only: the direct-invoke forward flag (C1.5)", () => {
    const removedGuid = "BILLS-119hr9ih";
    const removedSk = `2026-01-01T00:00:00.000Z#${removedGuid}`;

    const record = (messageId: string, key: string, eventName = "ObjectCreated:Put") => ({
      messageId,
      body: JSON.stringify({ Records: [{ eventName, s3: { object: { key } } }] }),
    });

    // Two adds, one unparseable bill and one removal of a stored bill.
    const records = [
      record("m1", "processed-bills/BILLS-119hr1.json"),
      record("m2", "processed-bills/BILLS-119hr2.json"),
      record("m3", "processed-bills/BILLS-119hr3.json"),
      record("m4", "processed-bills/BILLS-119hr9.json", "ObjectRemoved:Delete"),
    ];

    const seedStored = (): Items => ({
      [ddbKey("BILL", removedSk)]: { pk: { S: "BILL" }, sk: { S: removedSk }, guid: { S: removedGuid } },
      [ddbKey("BILL_GUID", removedGuid)]: {
        pk: { S: "BILL_GUID" },
        sk: { S: removedGuid },
        manifestSk: { S: removedSk },
      },
    });

    const serve = () => {
      const { Readable } = require("stream");
      const bodies: Record<string, string> = {
        "processed-bills/BILLS-119hr1.json": JSON.stringify({
          kind: "processed",
          storedAt: "2026-01-05T10:30:00.000Z",
          identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
          guid: "BILLS-119hr1ih",
          title: "Bill 1",
          sponsors: ["A000001"],
        }),
        "processed-bills/BILLS-119hr2.json": "{not json",
        "processed-bills/BILLS-119hr3.json": JSON.stringify({
          kind: "processed",
          storedAt: "2026-01-06T10:30:00.000Z",
          identifier: { congress: "119", billType: "house-bill", billNumber: "3" },
          guid: "BILLS-119hr3ih",
          title: "Bill 3",
        }),
      };
      mockSend.mockImplementation((cmd: S3Command) => {
        const key = cmd.input.Key!;
        if (cmd.__type === "GetObjectCommand" && key in bodies)
          return { Body: Readable.from([Buffer.from(bodies[key])]) };
        throw new Error("Unexpected S3 request: " + cmd.__type + " " + JSON.stringify(cmd.input));
      });
    };

    /** Runs the handler on fresh state and returns what it wrote to DynamoDB and sent to SQS. */
    const runWith = async (event: { Records: object[]; forward?: unknown }) => {
      jest.clearAllMocks();
      mockSqsSend.mockImplementation((cmd: SqsCommand) => ({
        Successful: cmd.input.Entries.map((entry: SqsEntry) => ({ Id: entry.Id })),
        Failed: [],
      }));
      const ddbItems = seedStored();
      mockDdbSend.mockImplementation(buildDdbMock(ddbItems));
      serve();
      const res = await handler(asSqsEvent(event));
      return {
        res,
        body: JSON.parse(res.body),
        ddbCalls: mockDdbSend.mock.calls.map(([cmd]: [DdbCommand]) => ({ type: cmd.__type, input: cmd.input })),
        ddbItems,
        sqsCalls: mockSqsSend.mock.calls.length,
      };
    };

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-10-07T20:00:00.000Z"));
      jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("makes no SendMessageBatch call and the same DynamoDB writes as an event without the flag", async () => {
      const rowsOnly = await runWith({ Records: records, forward: false });
      const today = await runWith({ Records: records });

      expect(rowsOnly.sqsCalls).toBe(0);
      expect(today.sqsCalls).toBeGreaterThan(0);
      expect(rowsOnly.ddbCalls).toEqual(today.ddbCalls);
      expect(rowsOnly.ddbItems).toEqual(today.ddbItems);
      // The fixtures carry suffixed guids; rows and lookups are keyed by the plain guid (REL-41).
      expect(rowsOnly.ddbItems[ddbKey("BILL_GUID", "BILLS-119hr1")]).toBeDefined();
      expect(rowsOnly.ddbItems[ddbKey("BILL_GUID", "BILLS-119hr3")]).toBeDefined();
      expect(rowsOnly.ddbItems[ddbKey("BILL", removedSk)]).toBeUndefined();

      // The failed record is still reported, so the backfill can map it back to its key.
      expect(rowsOnly.res.batchItemFailures).toEqual([{ itemIdentifier: "m2" }]);
      expect(rowsOnly.res.batchItemFailures).toEqual(today.res.batchItemFailures);
      expect(rowsOnly.body).toMatchObject({ forward: false, enqueued: 0, addedOrUpdated: 2, deleted: 1 });
      expect(today.body).toMatchObject({ forward: true, enqueued: 2, addedOrUpdated: 2, deleted: 1 });
    });

    it("forwards exactly as an event without the flag when forward is true or any value other than false", async () => {
      const sentKeys = () =>
        mockSqsSend.mock.calls.flatMap(([cmd]: [SqsCommand]) =>
          cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody).Records[0].s3.object.key),
        );

      const today = await runWith({ Records: records });
      const todayKeys = sentKeys();
      const explicit = await runWith({ Records: records, forward: true });
      const explicitKeys = sentKeys();
      const notBoolean = await runWith({ Records: records, forward: "false" });
      const notBooleanKeys = sentKeys();

      expect(todayKeys).toEqual(["processed-bills/BILLS-119hr1.json", "processed-bills/BILLS-119hr3.json"]);
      expect(explicitKeys).toEqual(todayKeys);
      expect(notBooleanKeys).toEqual(todayKeys);
      expect(explicit.ddbCalls).toEqual(today.ddbCalls);
      expect(explicit.body.forward).toBe(true);
      expect(notBoolean.body.forward).toBe(true);
    });

    it("answers the backfill preflight with forward false and touches nothing", async () => {
      const preflight = await runWith({ Records: [], forward: false });

      expect(preflight.res.batchItemFailures).toEqual([]);
      expect(preflight.body).toEqual({
        generatedAt: "2026-10-07T20:00:00.000Z",
        updated: false,
        enqueued: 0,
        addedOrUpdated: 0,
        deleted: 0,
        forward: false,
      });
      expect(preflight.res.body).toContain('"forward":false');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(preflight.sqsCalls).toBe(0);
    });

    it("echoes forward true in the early return when the flag is absent", async () => {
      const empty = await runWith({ Records: [] });
      expect(empty.body).toMatchObject({ updated: false, forward: true });
    });
  });

  describe("member-stats and notificationType forward (CAP-05, REL-59)", () => {
    const MEMBER_STATS_QUEUE = "https://example.com/member-stats";
    const NOTIFY_QUEUE = "https://example.com/test-queue";

    // The handler reads CONGRESS_MEMBER_STATS_QUEUE_URL at load, so it is loaded in isolation with it set.
    const load = () => {
      let loaded!: LoadedHandler;
      jest.isolateModules(() => {
        process.env.CONGRESS_MEMBER_STATS_QUEUE_URL = MEMBER_STATS_QUEUE;
        loaded = {
          handler: require("../handlers/createBillsManifest").handler,
          s3Send: require("@aws-sdk/client-s3").__mockSend,
          sqsSend: require("@aws-sdk/client-sqs").__mockSend,
          ddbSend: require("@aws-sdk/client-dynamodb").__mockSend,
        };
      });
      loaded.sqsSend.mockImplementation((cmd: SqsCommand) => ({
        Successful: cmd.input.Entries.map((entry: SqsEntry) => ({ Id: entry.Id })),
        Failed: [],
      }));
      loaded.ddbSend.mockImplementation(buildDdbMock({}));
      loaded.s3Send.mockImplementation((cmd: S3Command) => {
        const { Readable } = require("stream");
        const guid = String(cmd.input.Key ?? "").replace(/^processed-bills\/|\.json$/g, "");
        return {
          Body: Readable.from([
            Buffer.from(
              JSON.stringify({
                kind: "processed",
                storedAt: "2026-09-25T10:00:00.000Z",
                identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
                guid: `${guid}ih`,
                title: "Bill",
              }),
            ),
          ]),
        };
      });
      return loaded;
    };

    const record = (messageId: string, key: string, versionId?: string, eventName = "ObjectCreated:Put") => ({
      messageId,
      body: JSON.stringify({
        Records: [{ eventName, s3: { object: { key, ...(versionId ? { versionId } : {}) } } }],
      }),
    });

    const sentTo = (sqsSend: jest.Mock, queueUrl: string) =>
      sqsSend.mock.calls
        .filter(([cmd]: [SqsCommand]) => cmd.input.QueueUrl === queueUrl)
        .flatMap(([cmd]: [SqsCommand]) =>
          cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody).Records[0].s3),
        );

    afterEach(() => {
      delete process.env.CONGRESS_MEMBER_STATS_QUEUE_URL;
    });

    it("sends member stats and notificationType the event's versionId (CAP-05, REL-59)", async () => {
      const { handler: loaded, sqsSend } = load();

      const res = await loaded(asSqsEvent({ Records: [record("m1", "processed-bills/BILLS-119hr1.json", "v7")] }));

      expect(res.batchItemFailures).toEqual([]);
      expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([
        { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-119hr1.json", versionId: "v7" } },
      ]);
      // NotificationType reads each body with extractS3ObjectRefsFromSQSEvent and judges the version it names.
      const notifyBodies = sqsSend.mock.calls
        .filter(([cmd]: [SqsCommand]) => cmd.input.QueueUrl === NOTIFY_QUEUE)
        .flatMap(([cmd]: [SqsCommand]) => cmd.input.Entries.map((entry: SqsEntry) => ({ body: entry.MessageBody })));
      expect(extractS3ObjectRefsFromSQSEvent(asSqsEvent({ Records: notifyBodies }))).toEqual([
        { key: "processed-bills/BILLS-119hr1.json", versionId: "v7" },
      ]);
    });

    it("sends member stats and notificationType each written version once, also two versions of a bill in one batch (REL-59)", async () => {
      const { handler: loaded, sqsSend } = load();

      await loaded(
        asSqsEvent({
          Records: [
            record("m1", "processed-bills/BILLS-119hr1.json", "v1"),
            record("m2", "processed-bills/BILLS-119hr1.json", "v2"),
            // S3 delivers events at least once.
            record("m3", "processed-bills/BILLS-119hr1.json", "v2"),
          ],
        }),
      );

      expect(
        sentTo(sqsSend, MEMBER_STATS_QUEUE).map((s3: { object: { versionId: string } }) => s3.object.versionId),
      ).toEqual(["v1", "v2"]);
      expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
        { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-119hr1.json", versionId: "v1" } },
        { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-119hr1.json", versionId: "v2" } },
      ]);
    });

    it("forwards both versions when one record names two versions of a key, and each once", async () => {
      const { handler: loaded, sqsSend } = load();
      const twoVersions = {
        messageId: "m1",
        body: JSON.stringify({
          Records: ["v1", "v2", "v1"].map((versionId) => ({
            eventName: "ObjectCreated:Put",
            s3: { object: { key: "processed-bills/BILLS-119hr1.json", versionId } },
          })),
        }),
      };

      const res = await loaded(asSqsEvent({ Records: [twoVersions] }));

      expect(res.batchItemFailures).toEqual([]);
      for (const queue of [NOTIFY_QUEUE, MEMBER_STATS_QUEUE]) {
        expect(sentTo(sqsSend, queue).map((s3: { object: { versionId: string } }) => s3.object.versionId)).toEqual([
          "v1",
          "v2",
        ]);
      }
      expect(JSON.parse(res.body).enqueued).toBe(4);
    });

    it("drops the versionId when the event named a key that normalization rewrote", async () => {
      const { handler: loaded, sqsSend } = load();

      await loaded(asSqsEvent({ Records: [record("m1", "processed-bills/BILLS-119hr1ih.json", "v9")] }));

      expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([
        { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-119hr1.json" } },
      ]);
      expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
        { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-119hr1.json" } },
      ]);
    });

    it("sends nothing to member stats or notificationType when forward is false, and still writes the row", async () => {
      const { handler: loaded, sqsSend, ddbSend } = load();

      const res = await loaded({
        ...asSqsEvent({ Records: [record("m1", "processed-bills/BILLS-119hr1.json", "v7")] }),
        forward: false,
      });

      expect(res.batchItemFailures).toEqual([]);
      expect(sqsSend).not.toHaveBeenCalled();
      expect(JSON.parse(res.body)).toMatchObject({ forward: false, enqueued: 0, addedOrUpdated: 1 });
      expect(ddbSend.mock.calls.some(([cmd]: [DdbCommand]) => cmd.__type === "TransactWriteItemsCommand")).toBe(true);
    });

    it("does not send removed processed bills to member stats", async () => {
      const { handler: loaded, sqsSend } = load();

      await loaded(
        asSqsEvent({ Records: [record("m1", "processed-bills/BILLS-119hr1.json", "v3", "ObjectRemoved:Delete")] }),
      );

      expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([]);
    });

    it("fails the record when the member-stats send fails, so SQS redelivers it", async () => {
      const { handler: loaded, sqsSend } = load();
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      sqsSend.mockImplementation((cmd: SqsCommand) => {
        if (cmd.input.QueueUrl === MEMBER_STATS_QUEUE) throw new Error("SQS unavailable");
        return { Successful: cmd.input.Entries.map((entry: SqsEntry) => ({ Id: entry.Id })), Failed: [] };
      });

      const res = await loaded(asSqsEvent({ Records: [record("m1", "processed-bills/BILLS-119hr1.json", "v1")] }));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
      jest.restoreAllMocks();
    });
  });

  describe("manifest dates: only news moves a row (RUNBOOK 4.9)", () => {
    const MEMBER_STATS_QUEUE = "https://example.com/member-stats";
    const NOTIFY_QUEUE = "https://example.com/test-queue";
    const guid = "BILLS-119hr2743";
    const key = `processed-bills/${guid}.json`;
    const TEXT = { "source-text-hash": "v1:0b6f1c1d2a3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccdd" };
    const NEW_TEXT = { "source-text-hash": "v1:ffeeddccbbaa99887766554433221100f9e8d7c6b5a49382716051f4e3d2c1b0" };
    const cosponsors = (count: number) =>
      Array.from({ length: count }, (_, index) => `C${String(index).padStart(6, "0")}`);

    /** The version before the bulk runs: cosponsors cut off at 20 (REL-28). */
    const base = {
      kind: "processed",
      storedAt: "2026-03-19T16:57:53.915Z",
      identifier: { congress: "119", billType: "hr", billNumber: "2743" },
      guid,
      title: "Lowers Drug Costs for Seniors",
      soWhat: "Seniors would pay less for insulin.",
      subCategories: ["Healthcare"],
      lifeAreas: ["Medical Costs"],
      sponsors: ["R000606"],
      cosponsors: cosponsors(20),
      actions: [
        { actionCode: "H11100", actionDate: "2026-02-10", text: "Referred to the Committee on Energy and Commerce." },
        { actionCode: "1025", actionDate: "2026-02-12", text: "Reported by the Committee" },
      ],
      committees: [],
      billStatus: "New",
    };
    const baseSk = `${base.storedAt}#${guid}`;
    const BULK_STORED_AT = "2026-10-11T22:41:29.355Z";
    const bulkSk = `${BULK_STORED_AT}#${guid}`;
    const version = (changes: Record<string, unknown>) => ({ ...base, storedAt: BULK_STORED_AT, ...changes });
    /** The U9b refetch: the full cosponsor list and a new storedAt, nothing else. */
    const refill = version({ cosponsors: cosponsors(177) });
    /** The date basis CreateBillsManifest stores for a document stored with `metadata`. */
    const basisOf = (doc: Record<string, unknown>, metadata: Record<string, string> | null = TEXT) =>
      formatDateBasis(manifestDateBasis(doc, metadata?.["source-text-hash"]));

    let s3: FakeVersionedS3;

    /** The handler loaded with both forward queues, on a versioned bucket and an in-memory table. */
    const load = (ddbItems: Items) => {
      let loaded!: LoadedHandler;
      jest.isolateModules(() => {
        process.env.CONGRESS_MEMBER_STATS_QUEUE_URL = MEMBER_STATS_QUEUE;
        loaded = {
          handler: require("../handlers/createBillsManifest").handler,
          s3Send: require("@aws-sdk/client-s3").__mockSend,
          sqsSend: require("@aws-sdk/client-sqs").__mockSend,
          ddbSend: require("@aws-sdk/client-dynamodb").__mockSend,
        };
      });
      loaded.sqsSend.mockImplementation((cmd: SqsCommand) => ({
        Successful: cmd.input.Entries.map((entry: SqsEntry) => ({ Id: entry.Id })),
        Failed: [],
      }));
      loaded.ddbSend.mockImplementation(buildDdbMock(ddbItems));
      loaded.s3Send.mockImplementation(async (cmd: S3Command) => {
        const response = await s3.send({
          __cmd: cmd.__type.replace(/Command$/, "") as FakeS3Command["__cmd"],
          input: cmd.input,
        });
        if (cmd.__type !== "GetObjectCommand" || !hasBody(response)) return response;
        // The handler streams the body, as the SDK's Readable in Lambda.
        return {
          ...response,
          Body: jsonReadable(JSON.parse(await response.Body.transformToString())),
        };
      });
      return loaded;
    };

    /**
     * The row and lookup a handler wrote for `doc` at `updatedAt`, with `contentHash`, `dateBasis` and
     * `documentStoredAt` when given (an older release wrote none, the release of 2026-10-14 only the hash).
     */
    const seedRow = (
      doc: BillDoc,
      {
        updatedAt = doc.storedAt,
        contentHash,
        dateBasis,
        documentStoredAt,
        voteCount = "0",
      }: {
        updatedAt?: string;
        contentHash?: string;
        dateBasis?: string;
        documentStoredAt?: string;
        voteCount?: string;
      } = {},
    ): Items => {
      const sk = `${updatedAt}#${guid}`;
      return {
        [ddbKey("BILL", sk)]: {
          pk: { S: "BILL" },
          sk: { S: sk },
          guid: { S: guid },
          billType: { S: "hr" },
          congress: { S: "119" },
          billNumber: { S: "2743" },
          updatedAt: { S: updatedAt },
          title: { S: doc.title },
          subCategories: { L: doc.subCategories.map((value: string) => ({ S: value })) },
          lifeAreas: { L: doc.lifeAreas.map((value: string) => ({ S: value })) },
          sponsors: { L: doc.sponsors.map((value: string) => ({ S: value })) },
          cosponsors: { L: doc.cosponsors.map((value: string) => ({ S: value })) },
          voteCount: { N: voteCount },
          ...(doc.billStatus ? { billStatus: { S: doc.billStatus } } : {}),
          ...(contentHash ? { contentHash: { S: contentHash } } : {}),
          ...(dateBasis ? { dateBasis: { S: dateBasis } } : {}),
          ...(documentStoredAt ? { documentStoredAt: { S: documentStoredAt } } : {}),
        },
        [ddbKey("BILL_GUID", guid)]: {
          pk: { S: "BILL_GUID" },
          sk: { S: guid },
          guid: { S: guid },
          manifestSk: { S: sk },
          updatedAt: { S: updatedAt },
        },
      };
    };

    /** A row this release wrote for `doc` (stored with `metadata`): stamped with its hash, date basis and storedAt. */
    const seedCurrentRow = (
      doc: BillDoc,
      {
        metadata = TEXT,
        ...options
      }: { updatedAt?: string; voteCount?: string; metadata?: Record<string, string> | null } = {},
    ) =>
      seedRow(doc, {
        ...options,
        contentHash: billContentHash(doc),
        dateBasis: basisOf(doc, metadata),
        documentStoredAt: doc.storedAt,
      });

    const event = (versionId?: string) =>
      asSqsEvent({
        Records: [
          {
            messageId: "m1",
            body: JSON.stringify({ Records: [{ s3: { object: { key, ...(versionId ? { versionId } : {}) } } }] }),
          },
        ],
      });

    const transactions = (ddbSend: jest.Mock) =>
      ddbSend.mock.calls
        .filter(([cmd]: [DdbCommand]) => cmd.__type === "TransactWriteItemsCommand")
        .map(([cmd]: [DdbCommand]) => cmd as TransactCommand);

    const sentTo = (sqsSend: jest.Mock, queueUrl: string) =>
      sqsSend.mock.calls
        .filter(([cmd]: [SqsCommand]) => cmd.input.QueueUrl === queueUrl)
        .flatMap(([cmd]: [SqsCommand]) =>
          cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody).Records[0].s3),
        );

    const dateLines = (info: jest.SpyInstance) =>
      info.mock.calls.filter(([message]) => message === "Dated manifest upsert").map(([, fields]) => fields);

    const rowKeys = (ddbItems: Items) => Object.keys(ddbItems).sort();

    let info: jest.SpyInstance;
    let warn: jest.SpyInstance;

    /** The warnings of a failed read of the version before the one read (readPreviousVersion). */
    const failedPreviousReads = () =>
      warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.startsWith("Could not read the previous processed bill version"),
      );

    beforeEach(() => {
      s3 = new FakeVersionedS3("2026-03-19T16:57:53.000Z");
      info = jest.spyOn(console, "info").mockImplementation(() => undefined);
      warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      jest.spyOn(Math, "random").mockReturnValue(0); // zero retry backoff
    });

    afterEach(() => {
      delete process.env.CONGRESS_MEMBER_STATS_QUEUE_URL;
      jest.restoreAllMocks();
    });

    it("stamps a new row with the contentHash and date basis of its document (a first publication)", async () => {
      const ddbItems: Items = {};
      const { handler: loaded } = load(ddbItems);
      s3.put(key, base, TEXT);

      await loaded(event());

      expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
        updatedAt: { S: base.storedAt },
        contentHash: { S: billContentHash(base) },
        dateBasis: { S: basisOf(base) },
      });
      expect(ddbItems[ddbKey("BILL_GUID", guid)].contentHash).toBeUndefined();
      expect(ddbItems[ddbKey("BILL_GUID", guid)].dateBasis).toBeUndefined();
      expect(dateLines(info)).toEqual([]);
    });

    it("stamps a legacy row on the same-key path, without moving it", async () => {
      const ddbItems = seedRow(base, { voteCount: "3" });
      const { handler: loaded, ddbSend } = load(ddbItems);
      s3.put(key, base, TEXT);

      await loaded(event());

      expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
      expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
        contentHash: { S: billContentHash(base) },
        dateBasis: { S: basisOf(base) },
        voteCount: { N: "3" },
      });
      expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Delete)).toBe(false);
    });

    describe("a row with a date basis: the basis decides, with no S3 read", () => {
      const keptCases: Array<[string, BillDoc, Record<string, string>]> = [
        ["the same document stored again (a reprocess)", version({}), TEXT],
        ["a cosponsor refill (U9b)", refill, TEXT],
        [
          "a re-summary of the same text (LLM-11/14)",
          version({ title: "Caps Insulin Costs", soWhat: "Insulin would cost at most $35.", civicProfile: { a: 1 } }),
          TEXT,
        ],
        ["new topics and life areas", version({ subCategories: ["Health Care"], lifeAreas: ["Retirement"] }), TEXT],
        [
          "member votes filled in (vote enrichment)",
          version({ officialVotes: { house: { yea: 1, nay: 0, members: [{ bioguideId: "A000055" }] } } }),
          TEXT,
        ],
        ["committees", version({ committees: [{ name: "Energy and Commerce Committee" }] }), TEXT],
        [
          "an older action filled in",
          version({ actions: [{ actionDate: "2026-02-01", text: "Sponsor remarks" }, ...base.actions] }),
          TEXT,
        ],
        [
          "the latest action's code and time added",
          version({ actions: [base.actions[0], { ...base.actions[1], actionCode: "H12200", actionTime: "10:00:00" }] }),
          TEXT,
        ],
        ["a legacy bill's first source-text-hash", refill, TEXT],
      ];

      it.each(keptCases)(
        "keeps the row's date for %s and still rewrites it and forwards it",
        async (name, doc, meta) => {
          const legacyText = name === "a legacy bill's first source-text-hash";
          const ddbItems = seedCurrentRow(base, { voteCount: "42", metadata: legacyText ? null : TEXT });
          const lookupBefore = ddbItems[ddbKey("BILL_GUID", guid)];
          const { handler: loaded, sqsSend } = load(ddbItems);
          s3.put(key, base, legacyText ? undefined : TEXT);
          const versionId = s3.put(key, doc, meta);

          const res = await loaded(event(versionId));

          expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
          expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
            updatedAt: { S: base.storedAt },
            voteCount: { N: "42" },
            title: { S: doc.title },
            lifeAreas: { L: doc.lifeAreas.map((value: string) => ({ S: value })) },
            contentHash: { S: billContentHash(doc) },
            dateBasis: { S: basisOf(doc, meta) },
          });
          expect(ddbItems[ddbKey("BILL_GUID", guid)]).toEqual(lookupBefore);
          expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", moves: [], decidedBy: "dateBasis" }),
          ]);
          expect(s3.commands("ListObjectVersions")).toEqual([]);
          // Only the date rule changed: every version still goes to NotificationType and member stats.
          expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
            { bucket: { name: "test-bucket" }, object: { key, versionId } },
          ]);
          expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([
            { bucket: { name: "test-bucket" }, object: { key, versionId } },
          ]);
        },
      );

      const movedCases: Array<[string, Record<string, unknown>, Record<string, string>, string[]]> = [
        ["a status change (Passed)", version({ billStatus: "Passed" }), TEXT, ["status"]],
        [
          "an action dated after the latest",
          version({ actions: [...base.actions, { actionDate: "2026-10-10", text: "Passed House" }] }),
          TEXT,
          ["newerAction"],
        ],
        [
          "another action on the latest date",
          version({ actions: [...base.actions, { actionDate: "2026-02-12", text: "Placed on the Union Calendar" }] }),
          TEXT,
          ["newActionEntry"],
        ],
        ["a new text version", version({ soWhat: "Now caps insulin at $25." }), NEW_TEXT, ["textVersion"]],
      ];

      it.each(movedCases)("moves the row for %s and forwards it as before", async (_name, doc, meta, moves) => {
        const ddbItems = seedCurrentRow(base, { voteCount: "42" });
        const { handler: loaded, sqsSend } = load(ddbItems);
        s3.put(key, base, TEXT);
        const versionId = s3.put(key, doc, meta);

        const res = await loaded(event(versionId));

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", bulkSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", bulkSk)]).toMatchObject({
          updatedAt: { S: BULK_STORED_AT },
          voteCount: { N: "42" },
          contentHash: { S: billContentHash(doc) },
          dateBasis: { S: basisOf(doc, meta) },
        });
        expect(ddbItems[ddbKey("BILL_GUID", guid)]).toMatchObject({
          manifestSk: { S: bulkSk },
          updatedAt: { S: BULK_STORED_AT },
        });
        expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "moved", moves, decidedBy: "dateBasis" }),
        ]);
        expect(s3.commands("ListObjectVersions")).toEqual([]);
        expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
          { bucket: { name: "test-bucket" }, object: { key, versionId } },
        ]);
      });

      it("judges the next version against the basis a kept write stored, not the row's date", async () => {
        // Kept first (a re-summary), then a status change: the second moves the row although the first did not.
        const ddbItems = seedCurrentRow(base);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base, TEXT);
        const resummary = version({ title: "Caps Insulin Costs" });
        s3.put(key, resummary, TEXT);
        await loaded(event());
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });

        const passed = { ...resummary, storedAt: "2026-10-20T09:00:00.000Z", billStatus: "Passed" };
        s3.put(key, passed, TEXT);
        await loaded(event());

        const passedSk = `${passed.storedAt}#${guid}`;
        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", passedSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", passedSk)]).toMatchObject({
          billStatus: { S: "Passed" },
          title: { S: "Caps Insulin Costs" },
        });
        expect(dateLines(info).map((line) => [line.decision, line.moves])).toEqual([
          ["kept", []],
          ["moved", ["status"]],
        ]);
      });

      it("falls back like a row without one when the basis is malformed", async () => {
        const ddbItems = seedRow(base, { contentHash: billContentHash(base), dateBasis: "d9|New|||" });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base, TEXT);
        s3.put(key, version({ title: "Caps Insulin Costs" }), TEXT);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "kept", changeClass: "user_visible", decidedBy: "previousVersion" }),
        ]);
      });
    });

    describe("Congressional Record citations are not news (2026-11-12)", () => {
      /** `base` with its latest action's text replaced, as congress.gov edits an action already there. */
      const latestText = (text: string, changes: Record<string, unknown> = {}) =>
        version({ actions: [base.actions[0], { ...base.actions[1], text }], ...changes });
      const CITED = latestText("Reported by the Committee (text: CR H6104-6105)");
      const RECITED = latestText("Reported by the Committee (text: CR H6104)");
      const REWORDED = latestText("Reported by the Committee on Energy and Commerce. H. Rept. 119-876.");
      const ANOTHER = version({
        actions: [
          ...base.actions,
          { actionDate: "2026-02-12", text: "Placed on the Union Calendar, Calendar No. 773." },
        ],
      });
      /** The d1 basis a release of 2026-10-28 to 2026-11-12 wrote for `doc`: its keys digest each text with its citations. */
      const legacyBasisOf = (doc: Record<string, unknown>, metadata: Record<string, string> | null = TEXT) => {
        const computed = manifestDateBasis(doc, metadata?.["source-text-hash"]);
        const keys = Array.from(new Set(computed.latestActionKeyPairs!.map(([d1Key]) => d1Key))).sort();
        return ["d1", computed.status, computed.latestActionDate, keys.join("."), computed.textVersion].join("|");
      };
      /** A row a release of 2026-10-28 to 2026-11-12 wrote for `doc`: its hash, its d1 basis and its storedAt. */
      const seedLegacyRow = (doc: BillDoc) =>
        seedRow(doc, {
          contentHash: billContentHash(doc),
          dateBasis: legacyBasisOf(doc),
          documentStoredAt: doc.storedAt,
          voteCount: "7",
        });

      it("keeps a row this release wrote (d2) for a citation added, by the basis alone", async () => {
        const ddbItems = seedCurrentRow(base);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base, TEXT);
        s3.put(key, CITED, TEXT);

        await loaded(event());

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        // The citation changes the document's hash but not its basis.
        expect(billContentHash(CITED)).not.toBe(billContentHash(base));
        expect(basisOf(CITED)).toBe(basisOf(base));
        expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({ dateBasis: { S: basisOf(CITED) } });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({
            decision: "kept",
            moves: [],
            decidedBy: "dateBasis",
            basis: "d2",
            sameDay: "same",
          }),
        ]);
        expect(s3.commands("ListObjectVersions")).toEqual([]);
      });

      it("moves a row this release wrote (d2) for another action on the latest date", async () => {
        const ddbItems = seedCurrentRow(CITED);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, CITED, TEXT);
        s3.put(key, { ...ANOTHER, storedAt: "2026-10-20T09:00:00.000Z" }, TEXT);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `2026-10-20T09:00:00.000Z#${guid}` });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "moved", moves: ["newActionEntry"], basis: "d2", sameDay: "new" }),
        ]);
      });

      describe("a row an older release wrote (d1), whose keys hold the citations", () => {
        it("keeps it for a citation added, by the basis alone, and stores the d2 basis", async () => {
          const ddbItems = seedLegacyRow(base);
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base, TEXT);
          s3.put(key, CITED, TEXT);

          await loaded(event());

          expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
          expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
            updatedAt: { S: base.storedAt },
            voteCount: { N: "7" },
            contentHash: { S: billContentHash(CITED) },
            dateBasis: { S: basisOf(CITED) },
          });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({
              decision: "kept",
              moves: [],
              decidedBy: "dateBasis",
              basis: "d1",
              sameDay: "same",
            }),
          ]);
          expect(s3.commands("ListObjectVersions")).toEqual([]);
        });

        it("keeps it for a citation changed, which the version the row reflects tells", async () => {
          const ddbItems = seedLegacyRow(CITED);
          const { handler: loaded } = load(ddbItems);
          s3.put(key, CITED, TEXT);
          s3.put(key, { ...RECITED, storedAt: "2026-10-20T09:00:00.000Z" }, TEXT);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `${CITED.storedAt}#${guid}` });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({
              decision: "kept",
              moves: [],
              decidedBy: "previousVersion",
              basis: "d1",
              sameDay: "unknown",
            }),
          ]);
          expect(s3.commands("ListObjectVersions")).toHaveLength(1);
        });

        it("moves it for a reworded action, which the version the row reflects tells", async () => {
          const ddbItems = seedLegacyRow(base);
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base, TEXT);
          s3.put(key, REWORDED, TEXT);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({
              decision: "moved",
              moves: ["newActionEntry"],
              decidedBy: "previousVersion",
              basis: "d1",
              sameDay: "unknown",
            }),
          ]);
        });

        it("keeps it when it cannot tell and the version before is not the row's", async () => {
          // The row reflects `base`; a version it never took (a write still in the queue) comes in between.
          const ddbItems = seedLegacyRow(base);
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base, TEXT);
          s3.put(key, { ...base, storedAt: "2026-10-11T20:00:00.000Z", title: "Another title" }, TEXT);
          s3.put(key, REWORDED, TEXT);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({
              decision: "kept",
              moves: [],
              decidedBy: "dateBasis",
              basis: "d1",
              sameDay: "unknown",
            }),
          ]);
          // The version before was read; the row does not reflect it. Only a failed read logs a warning (RUNBOOK 16.1).
          expect(s3.commands("ListObjectVersions")).toHaveLength(1);
          expect(failedPreviousReads()).toEqual([]);
        });

        it("keeps it when it cannot tell and the version listing fails", async () => {
          const ddbItems = seedLegacyRow(CITED);
          const { handler: loaded, s3Send } = load(ddbItems);
          s3.put(key, CITED, TEXT);
          s3.put(key, { ...RECITED, storedAt: "2026-10-20T09:00:00.000Z" }, TEXT);
          const send = s3Send.getMockImplementation()!;
          s3Send.mockImplementation(async (cmd: S3Command) => {
            if (cmd.__type === "ListObjectVersionsCommand") throw new Error("SlowDown");
            return send(cmd);
          });

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `${CITED.storedAt}#${guid}` });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", moves: [], decidedBy: "dateBasis", sameDay: "unknown" }),
          ]);
          expect(failedPreviousReads()).toEqual([
            [
              expect.any(String),
              expect.objectContaining({ key, error: expect.objectContaining({ message: "SlowDown" }) }),
            ],
          ]);
        });

        it("moves it for another action on the latest date, by the basis alone", async () => {
          const ddbItems = seedLegacyRow(CITED);
          const { handler: loaded } = load(ddbItems);
          s3.put(key, CITED, TEXT);
          const another = { ...ANOTHER, storedAt: "2026-10-20T09:00:00.000Z" };
          s3.put(key, another, TEXT);

          await loaded(event());

          const anotherSk = `${another.storedAt}#${guid}`;
          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: anotherSk });
          expect(ddbItems[ddbKey("BILL", anotherSk)]).toMatchObject({
            voteCount: { N: "7" },
            dateBasis: { S: basisOf(another) },
          });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({
              decision: "moved",
              moves: ["newActionEntry"],
              decidedBy: "dateBasis",
              basis: "d1",
              sameDay: "new",
            }),
          ]);
          expect(s3.commands("ListObjectVersions")).toEqual([]);
        });
      });

      describe("an older release reads a d2 row as one without a basis (a rollback)", () => {
        // The date basis pattern of the releases of 2026-10-28 to 2026-11-12 (8879b33 and before): d1 only.
        const OLDER_RELEASE_PATTERN =
          /^d1\|(New|Updated|Passed|Failed|Finalized)\|(\d{4}-\d{2}-\d{2}|)\|((?:[0-9a-f]{8}(?:\.[0-9a-f]{8})*)?)\|([0-9a-f]{16}|)$/;

        /** The handler with the older release's reading of a basis: a d2 basis is none. */
        const loadAsOlderRelease = (ddbItems: Items) => {
          jest.doMock("../shared/billVersionChange", () => {
            const actual = jest.requireActual("../shared/billVersionChange");
            return {
              ...actual,
              parseDateBasis: (value: unknown) =>
                typeof value === "string" && OLDER_RELEASE_PATTERN.test(value) ? actual.parseDateBasis(value) : null,
            };
          });
          try {
            return load(ddbItems);
          } finally {
            jest.dontMock("../shared/billVersionChange");
          }
        };

        it("keeps it for a bookkeeping change by its contentHash, with no S3 read", async () => {
          const ddbItems = seedCurrentRow(base);
          expect(ddbItems[ddbKey("BILL", baseSk)].dateBasis.S).not.toMatch(OLDER_RELEASE_PATTERN);
          const { handler: loaded } = loadAsOlderRelease(ddbItems);
          s3.put(key, base, TEXT);
          s3.put(key, refill, TEXT);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", decidedBy: "contentHash", basis: null }),
          ]);
          expect(s3.commands("ListObjectVersions")).toEqual([]);
        });

        it("judges any other change against the previous S3 version the row's contentHash names", async () => {
          const ddbItems = seedCurrentRow(base);
          const { handler: loaded } = loadAsOlderRelease(ddbItems);
          s3.put(key, base, TEXT);
          s3.put(key, version({ title: "Caps Insulin Costs" }), TEXT);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", decidedBy: "previousVersion", basis: null }),
          ]);
        });
      });
    });

    describe("a row an older release wrote with a contentHash only (2026-10-14 to this release)", () => {
      it("keeps the date for a cosponsor-only version by the hash alone, and still updates and forwards it", async () => {
        const ddbItems = seedRow(base, { contentHash: billContentHash(base), voteCount: "42" });
        const lookupBefore = ddbItems[ddbKey("BILL_GUID", guid)];
        const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
        s3.put(key, base, TEXT);
        const refillVersion = s3.put(key, refill, TEXT);

        const res = await loaded(event(refillVersion));

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        const row = ddbItems[ddbKey("BILL", baseSk)];
        expect(row).toMatchObject({
          sk: { S: baseSk },
          updatedAt: { S: base.storedAt },
          voteCount: { N: "42" },
          contentHash: { S: billContentHash(refill) },
          dateBasis: { S: basisOf(refill) },
        });
        expect(row.cosponsors.L).toHaveLength(177);
        expect(ddbItems[ddbKey("BILL_GUID", guid)]).toEqual(lookupBefore);

        const [transaction] = transactions(ddbSend);
        expect(transaction.input.TransactItems).toHaveLength(2);
        expect(transaction.input.TransactItems[0].Put).toMatchObject({
          Item: { sk: { S: baseSk }, updatedAt: { S: base.storedAt }, documentStoredAt: { S: BULK_STORED_AT } },
          ConditionExpression:
            "#voteCount = :observedVoteCount AND attribute_not_exists(#computedFrom) AND " +
            "#contentHash = :observedContentHash AND attribute_not_exists(#dateBasis) AND " +
            "attribute_not_exists(#documentStoredAt)",
          ExpressionAttributeValues: {
            ":observedVoteCount": { N: "42" },
            ":observedContentHash": { S: billContentHash(base) },
          },
        });
        expect(transaction.input.TransactItems[1].Put).toMatchObject({
          Item: { manifestSk: { S: baseSk }, updatedAt: { S: base.storedAt } },
          ConditionExpression: "#manifestSk = :expectedManifestSk",
          ExpressionAttributeValues: { ":expectedManifestSk": { S: baseSk } },
        });
        // Nothing about the version needs S3 beyond the read: the row's hash decided.
        expect(s3.commands("ListObjectVersions")).toEqual([]);

        const body = JSON.parse(res.body);
        expect(body.stats).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1, upsertsSkipped: 0 });
        expect(body.addedOrUpdated).toBe(1);
        expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
          { bucket: { name: "test-bucket" }, object: { key, versionId: refillVersion } },
        ]);
        expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([
          { bucket: { name: "test-bucket" }, object: { key, versionId: refillVersion } },
        ]);
        expect(dateLines(info)).toEqual([
          {
            guid,
            decision: "kept",
            moves: [],
            changeClass: "bookkeeping_only",
            decidedBy: "contentHash",
            basis: null,
            sameDay: null,
            rowUpdatedAt: base.storedAt,
            storedAt: BULK_STORED_AT,
          },
        ]);
      });

      it.each([
        [
          "an older action's text (detail_only)",
          { actions: [{ ...base.actions[0], text: "Referred." }, base.actions[1]] },
          "detail_only",
        ],
        ["a new title (user_visible)", { title: "Caps Insulin Costs" }, "user_visible"],
      ])(
        "keeps the date for %s, judged against the previous version the hash names",
        async (_name, changes, changeClass) => {
          const ddbItems = seedRow(base, { contentHash: billContentHash(base), voteCount: "42" });
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base, TEXT);
          const current = version({ ...changes, cosponsors: cosponsors(177) });
          s3.put(key, current, TEXT);

          const res = await loaded(event());

          expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
          expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
            updatedAt: { S: base.storedAt },
            voteCount: { N: "42" },
            contentHash: { S: billContentHash(current) },
            dateBasis: { S: basisOf(current) },
          });
          expect(JSON.parse(res.body).stats.upsertsKeptDate).toBe(1);
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", moves: [], changeClass, decidedBy: "previousVersion" }),
          ]);
          expect(s3.commands("ListObjectVersions")).toHaveLength(1);
        },
      );

      it("moves it for a new text version, which the previous version's metadata shows", async () => {
        const ddbItems = seedRow(base, { contentHash: billContentHash(base) });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base, TEXT);
        const current = version({ soWhat: "Now caps insulin at $25." });
        s3.put(key, current, NEW_TEXT);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "moved", moves: ["textVersion"], decidedBy: "previousVersion" }),
        ]);
      });

      it("keeps a re-dated row where it is when its key is replayed (redateManifestRows, then a redrive)", async () => {
        // The re-date moved the row back to the base date and stamped the hash of the current document.
        const ddbItems = seedRow(refill, { updatedAt: base.storedAt, contentHash: billContentHash(refill) });
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        const res = await loaded(event());

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
        expect(JSON.parse(res.body).stats.upsertsKeptDate).toBe(1);
        expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Delete)).toBe(false);
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "kept", changeClass: "bookkeeping_only", decidedBy: "contentHash" }),
        ]);
        expect(s3.commands("ListObjectVersions")).toEqual([]);
      });

      describe("a re-dated row with a version between its date and the replayed one (hr9641: U9e patch, then U9b)", () => {
        const patch = version({ storedAt: "2026-10-11T21:08:30.914Z", cosponsors: cosponsors(30) });

        it("is kept by its contentHash alone", async () => {
          const ddbItems = seedRow(refill, { updatedAt: base.storedAt, contentHash: billContentHash(refill) });
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base);
          s3.put(key, patch);
          s3.put(key, refill);

          await loaded(event());

          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
          expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "kept", decidedBy: "contentHash" })]);
          expect(s3.commands("ListObjectVersions")).toEqual([]);
        });

        it.each([
          ["a stamp of another hash version", billContentHash(refill).replace(/^v1:/, "v0:")],
          ["no stamp", undefined],
        ])("is kept by the row's own status and date with %s", async (_name, contentHash) => {
          const ddbItems = seedRow(refill, { updatedAt: base.storedAt, contentHash });
          const { handler: loaded } = load(ddbItems);
          s3.put(key, base);
          s3.put(key, patch);
          s3.put(key, refill);

          await loaded(event());

          // The version before the replayed one is the patch, which the row does not reflect.
          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
          expect(dateLines(info)).toEqual([
            expect.objectContaining({ decision: "kept", moves: [], changeClass: null, decidedBy: "row" }),
          ]);
          expect(s3.commands("ListObjectVersions")).toHaveLength(1);
        });
      });
    });

    describe("a legacy row (no contentHash, no basis): the previous S3 version decides, else the row itself", () => {
      it("keeps and stamps it when the previous version differs only by bookkeeping", async () => {
        const ddbItems = seedRow(base, { voteCount: "42" });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        await loaded(event());

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
          updatedAt: { S: base.storedAt },
          voteCount: { N: "42" },
          contentHash: { S: billContentHash(refill) },
          dateBasis: { S: basisOf(refill, null) },
        });
        expect(s3.commands("ListObjectVersions")).toHaveLength(1);
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "kept", changeClass: "bookkeeping_only", decidedBy: "previousVersion" }),
        ]);
      });

      it("keeps a March row dated 1.1 s after its document's storedAt", async () => {
        const marchUpdatedAt = "2026-03-19T16:57:55.015Z";
        const ddbItems = seedRow(base, { updatedAt: marchUpdatedAt });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        await loaded(event());

        const marchSk = `${marchUpdatedAt}#${guid}`;
        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", marchSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", marchSk)].updatedAt).toEqual({ S: marchUpdatedAt });
      });

      it("keeps it for a re-summary (the previous version had another title), the REL-32 and LLM-14 case", async () => {
        const ddbItems = seedRow(base);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, { ...base, title: "An earlier title" });
        s3.put(key, refill);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({
            decision: "kept",
            moves: [],
            changeClass: "user_visible",
            decidedBy: "previousVersion",
          }),
        ]);
      });

      it("moves it for an action the previous version did not have, although it is older than the row", async () => {
        // The row is dated 2026-03-19; the action of 2026-03-01 is new to it all the same.
        const ddbItems = seedRow(base);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, version({ actions: [...base.actions, { actionDate: "2026-03-01", text: "Passed House" }] }));

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "moved", moves: ["newerAction"], decidedBy: "previousVersion" }),
        ]);
      });

      it("moves it by its own date when the previous version is newer than the row and has a later action", async () => {
        const ddbItems = seedRow(base, { updatedAt: "2026-01-05T10:30:00.000Z" });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        await loaded(event());

        // The previous version is not the row's; its latest action (2026-02-12) is after the row's day.
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "moved", moves: ["newerAction"], changeClass: null, decidedBy: "row" }),
        ]);
      });

      it("moves it by its own status when the previous version is not the row's", async () => {
        const ddbItems = seedRow({ ...base, billStatus: "Failed" }, { updatedAt: "2026-04-01T00:00:00.000Z" });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
        expect(dateLines(info)).toEqual([expect.objectContaining({ moves: ["status"], decidedBy: "row" })]);
      });

      it("keeps it at its date with the restored content when the previous version is a rollback copy (RUNBOOK 5)", async () => {
        const good = { ...base, storedAt: "2026-09-01T10:00:00.000Z", title: "Good title" };
        const bad = { ...base, storedAt: "2026-09-20T10:00:00.000Z", title: "Bad title" };
        // The row reflects the bad version; the copy of the good one kept its storedAt, so the upsert skipped it.
        const ddbItems = seedRow(bad);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, good);
        s3.put(key, bad);
        s3.put(key, good);
        const next = { ...good, storedAt: "2026-10-20T10:00:00.000Z", cosponsors: cosponsors(25) };
        s3.put(key, next);

        await loaded(event());

        const badSk = `${bad.storedAt}#${guid}`;
        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", badSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", badSk)].title).toEqual({ S: "Good title" });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ decision: "kept", changeClass: null, decidedBy: "row" }),
        ]);
      });

      it("is judged by its own status and date when the version before is a delete marker", async () => {
        const ddbItems = seedRow(base);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.deleteObject(key);
        s3.put(key, refill);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
        expect(s3.commands("GetObject").filter((call) => call.input.VersionId)).toEqual([]);
        expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "kept", decidedBy: "row" })]);
      });

      it("is judged by its own status and date when the read named no version (no listing)", async () => {
        const ddbItems = seedRow(base);
        const { handler: loaded, s3Send } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);
        const versioned = s3Send.getMockImplementation()!;
        s3Send.mockImplementation(async (cmd: S3Command) => {
          const response = await versioned(cmd);
          return cmd.__type === "GetObjectCommand" ? { ...response, VersionId: undefined } : response;
        });

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: baseSk });
        expect(s3.commands("ListObjectVersions")).toEqual([]);
        expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "kept", decidedBy: "row" })]);
      });

      it("is judged by its own status and date when the version listing fails", async () => {
        const ddbItems = seedRow(base);
        const { handler: loaded, s3Send } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, version({ billStatus: "Passed" }));
        const versioned = s3Send.getMockImplementation()!;
        s3Send.mockImplementation(async (cmd: S3Command) => {
          if (cmd.__type === "ListObjectVersionsCommand") throw new Error("SlowDown");
          return versioned(cmd);
        });

        const res = await loaded(event());

        expect(res.batchItemFailures).toEqual([]);
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: bulkSk });
        expect(dateLines(info)).toEqual([expect.objectContaining({ moves: ["status"], decidedBy: "row" })]);
      });

      it("uses the previous version for a hash of another version", async () => {
        const ddbItems = seedRow(base, { contentHash: "v0:0123456789abcdef:0123456789abcdef" });
        const { handler: loaded } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL", baseSk)].contentHash).toEqual({ S: billContentHash(refill) });
        expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "kept", decidedBy: "previousVersion" })]);
      });

      it("reads the previous version once although the transaction is retried", async () => {
        const ddbItems = seedRow(base, { voteCount: "42" });
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, base);
        s3.put(key, refill);
        const table = buildDdbMock(ddbItems);
        let raced = false;
        ddbSend.mockImplementation((cmd: DdbCommand) => {
          if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
            raced = true;
            ddbItems[ddbKey("BILL", baseSk)] = { ...ddbItems[ddbKey("BILL", baseSk)], voteCount: { N: "43" } };
          }
          return table(cmd);
        });

        await loaded(event());

        expect(transactions(ddbSend)).toHaveLength(2);
        expect(s3.commands("ListObjectVersions")).toHaveLength(1);
        expect(ddbItems[ddbKey("BILL", baseSk)].voteCount).toEqual({ N: "43" });
      });
    });

    describe("ceremonial resolutions get no topics or life areas, and relabelling never moves a date (S6)", () => {
      const hresGuid = "BILLS-119hres1187";
      const hresKey = `processed-bills/${hresGuid}.json`;
      const ceremonial = {
        kind: "processed",
        storedAt: "2026-10-20T15:00:00.000Z",
        identifier: { congress: "119", billType: "hres", billNumber: "1187" },
        guid: hresGuid,
        title: "Recognize Community Health Workers Week",
        officialTitle: "Expressing support for the designation of Community Health Workers Week.",
        soWhat: "No law changes.",
        subCategories: ["Healthcare"],
        lifeAreas: ["Medical Costs"],
        sponsors: ["B001318"],
        cosponsors: [],
        actions: [{ actionDate: "2026-10-16", text: "Submitted in House" }],
        billStatus: "New",
      };
      const ceremonialSk = `${ceremonial.storedAt}#${hresGuid}`;
      const hresEvent = () =>
        asSqsEvent({
          Records: [{ messageId: "m1", body: JSON.stringify({ Records: [{ s3: { object: { key: hresKey } } }] }) }],
        });
      /** The row an older release wrote: the document's life areas, at its storedAt (or `updatedAt`), no basis. */
      const seedLegacyCeremonialRow = (updatedAt = ceremonial.storedAt, rowSk = `${updatedAt}#${hresGuid}`): Items => ({
        [ddbKey("BILL", rowSk)]: {
          pk: { S: "BILL" },
          sk: { S: rowSk },
          guid: { S: hresGuid },
          billType: { S: "hres" },
          congress: { S: "119" },
          billNumber: { S: "1187" },
          updatedAt: { S: updatedAt },
          title: { S: ceremonial.title },
          subCategories: { L: [{ S: "Healthcare" }] },
          lifeAreas: { L: [{ S: "Medical Costs" }] },
          sponsors: { L: [{ S: "B001318" }] },
          cosponsors: { L: [] },
          voteCount: { N: "7" },
          billStatus: { S: "New" },
        },
        [ddbKey("BILL_GUID", hresGuid)]: {
          pk: { S: "BILL_GUID" },
          sk: { S: hresGuid },
          guid: { S: hresGuid },
          manifestSk: { S: rowSk },
          updatedAt: { S: updatedAt },
        },
      });
      const lifeAreasOf = (row: Item) => row.lifeAreas.L!.map((value) => value.S);
      const topicsOf = (row: Item) => row.subCategories.L!.map((value) => value.S);

      it("writes a new ceremonial resolution's row without topics or life areas; the document keeps them", async () => {
        const ddbItems: Items = {};
        const { handler: loaded } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);

        await loaded(hresEvent());

        const row = ddbItems[ddbKey("BILL", ceremonialSk)];
        expect(lifeAreasOf(row)).toEqual([]);
        // Since 2026-10-29: the topics too, so no card shows a followed topic on it.
        expect(row.subCategories).toEqual({ L: [] });
        expect(row.contentHash).toEqual({ S: billContentHash(ceremonial) });
        expect(row.updatedAt).toEqual({ S: ceremonial.storedAt });
        expect(s3.json<{ lifeAreas: string[]; subCategories: string[] }>(hresKey)!.lifeAreas).toEqual([
          "Medical Costs",
        ]);
        expect(s3.json<{ lifeAreas: string[]; subCategories: string[] }>(hresKey)!.subCategories).toEqual([
          "Healthcare",
        ]);
      });

      it.each([
        ["the headline when there is no official title", { officialTitle: undefined }, false],
        [
          "a resolution that recognizes nothing ceremonial (a rule for a bill's consideration)",
          {
            title: "Set debate rules for the energy bill",
            officialTitle: "Providing for consideration of the bill (H.R. 77) to amend the Clean Air Act.",
          },
          true,
        ],
        [
          "a condemning resolution",
          { title: "Condemn Antisemitism", officialTitle: "Condemning the rise of antisemitism." },
          true,
        ],
        ["a censure", { title: "Censure Representative Doe", officialTitle: "Censuring Representative Doe." }, true],
        [
          "an impeachment",
          {
            title: "Impeach Judge Roe",
            officialTitle: "Impeaching Judge Roe, a judge of the United States District Court, for high crimes.",
          },
          true,
        ],
        [
          "a resolution that recognizes and calls on someone to act",
          {
            title: "Recognize the strike and urge action",
            officialTitle: "Recognizing the anniversary of the strike and calling on the Secretary to act.",
          },
          true,
        ],
        [
          "a bill that designates a post office",
          {
            identifier: { congress: "119", billType: "hr", billNumber: "1187" },
            officialTitle: "To designate the facility.",
          },
          true,
        ],
        [
          "the slug a March row's document may carry for its type",
          { identifier: { congress: "119", billType: "house-resolution", billNumber: "1187" } },
          false,
        ],
        [
          // BILLS-119hres1572, a card seen in the app (2026-10-29).
          "an official title that encourages the recognition of a day",
          {
            title: "Recognize National LGBTQ+ Servicemembers and Veterans Day",
            officialTitle: "Encouraging the recognition of a National LGBTQ+ Servicemembers and Veterans Day.",
          },
          false,
        ],
        [
          "a headline that also asks for something, when there is no official title",
          { title: "Recognize Overdose Awareness Day and fight the opioid crisis", officialTitle: undefined },
          true,
        ],
      ])("decides by %s", async (_name, changes, keepsLabels) => {
        const ddbItems: Items = {};
        const { handler: loaded } = load(ddbItems);
        s3.put(hresKey, { ...ceremonial, ...changes }, TEXT);

        await loaded(hresEvent());

        const row = ddbItems[ddbKey("BILL", ceremonialSk)];
        expect({ topics: topicsOf(row), lifeAreas: lifeAreasOf(row) }).toEqual(
          keepsLabels ? { topics: ["Healthcare"], lifeAreas: ["Medical Costs"] } : { topics: [], lifeAreas: [] },
        );
      });

      it("reads a document that wraps its raw snapshot in content.rawSnapshot", async () => {
        const ddbItems: Items = {};
        const { handler: loaded } = load(ddbItems);
        s3.put(
          hresKey,
          { kind: "processed", storedAt: ceremonial.storedAt, content: { rawSnapshot: ceremonial } },
          TEXT,
        );

        await loaded(hresEvent());

        const row = ddbItems[ddbKey("BILL", ceremonialSk)];
        expect({ topics: topicsOf(row), lifeAreas: lifeAreasOf(row) }).toEqual({ topics: [], lifeAreas: [] });
      });

      // The curated overrides of 2026-10-29 (RUNBOOK 4.12): the row as each bill's document is stored now (no official
      // title) and as a re-summary would store it (with Congress's), so the row's next write keeps the decision.
      it.each(CURATED_OVERRIDE_CASES)(
        "writes %s's row as its curated override decides, by %s",
        async (_guid, _titles, decision) => {
          const { guid, billType, billNumber, headline, officialTitle, ceremonial: isCeremonial } = decision;
          const key = `processed-bills/${guid}.json`;
          const document = {
            ...ceremonial,
            identifier: { congress: "119", billType, billNumber },
            guid,
            title: headline,
            officialTitle,
            subCategories: decision.subCategories,
            lifeAreas: decision.lifeAreas,
          };
          const ddbItems: Items = {};
          const { handler: loaded } = load(ddbItems);
          s3.put(key, document, TEXT);

          await loaded(
            asSqsEvent({
              Records: [{ messageId: "m1", body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }) }],
            }),
          );

          const row = ddbItems[ddbKey("BILL", `${document.storedAt}#${guid}`)];
          expect({ topics: topicsOf(row), lifeAreas: lifeAreasOf(row) }).toEqual(
            isCeremonial
              ? { topics: [], lifeAreas: [] }
              : { topics: decision.subCategories, lifeAreas: decision.lifeAreas },
          );
          expect(row.updatedAt).toEqual({ S: document.storedAt });
        },
      );

      // The bills held for review (RUNBOOK 4.12): the row keeps both lists, by the headline its document has now and
      // by the official title a re-summary stores, though a title rule would tag each.
      it.each(HELD_FOR_REVIEW_CASES)(
        "keeps %s's lists on its row while it is held, by %s",
        async (_guid, _titles, held) => {
          const { guid, billType, billNumber, headline, officialTitle } = held;
          const key = `processed-bills/${guid}.json`;
          const document = {
            ...ceremonial,
            identifier: { congress: "119", billType, billNumber },
            guid,
            title: headline,
            officialTitle,
            subCategories: ["Elections and Voting"],
            lifeAreas: ["Medical Costs"],
          };
          const ddbItems: Items = {};
          const { handler: loaded } = load(ddbItems);
          s3.put(key, document, TEXT);

          await loaded(
            asSqsEvent({
              Records: [{ messageId: "m1", body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }) }],
            }),
          );

          const row = ddbItems[ddbKey("BILL", `${document.storedAt}#${guid}`)];
          expect({ topics: topicsOf(row), lifeAreas: lifeAreasOf(row) }).toEqual({
            topics: ["Elections and Voting"],
            lifeAreas: ["Medical Costs"],
          });
        },
      );

      it("relabels an existing row in place when its version is replayed (backfill:bills-manifest)", async () => {
        const ddbItems = seedLegacyCeremonialRow();
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);

        await loaded(hresEvent());

        expect(Object.keys(ddbItems).sort()).toEqual(
          [ddbKey("BILL", ceremonialSk), ddbKey("BILL_GUID", hresGuid)].sort(),
        );
        expect(ddbItems[ddbKey("BILL", ceremonialSk)]).toMatchObject({
          updatedAt: { S: ceremonial.storedAt },
          voteCount: { N: "7" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          dateBasis: { S: basisOf(ceremonial) },
        });
        expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Delete)).toBe(false);
      });

      it("relabels a row dated 1.1 s after its document's storedAt (as the March load wrote them) on a replay", async () => {
        // The March load dated rows 0.6 to 2.1 s after their document; a replay used to skip them as older.
        const marchUpdatedAt = "2026-10-20T15:00:01.100Z";
        const marchSk = `${marchUpdatedAt}#${hresGuid}`;
        const ddbItems = seedLegacyCeremonialRow(marchUpdatedAt);
        const lookupBefore = ddbItems[ddbKey("BILL_GUID", hresGuid)];
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);

        const res = await loaded(hresEvent());

        expect(Object.keys(ddbItems).sort()).toEqual([ddbKey("BILL", marchSk), ddbKey("BILL_GUID", hresGuid)].sort());
        expect(ddbItems[ddbKey("BILL", marchSk)]).toMatchObject({
          updatedAt: { S: marchUpdatedAt },
          voteCount: { N: "7" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          contentHash: { S: billContentHash(ceremonial) },
          dateBasis: { S: basisOf(ceremonial) },
          documentStoredAt: { S: ceremonial.storedAt },
        });
        expect(ddbItems[ddbKey("BILL_GUID", hresGuid)]).toEqual(lookupBefore);
        expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Delete)).toBe(false);
        // Counted as written, as a replay at an equal key is; no date decision is logged.
        expect(JSON.parse(res.body).stats).toMatchObject({
          upsertsSucceeded: 1,
          upsertsSkipped: 0,
          upsertsKeptDate: 0,
        });
        expect(dateLines(info)).toEqual([]);

        // Replayed again, the stamped row is its version's still (its hash), and stays where it is.
        await loaded(hresEvent());
        expect(Object.keys(ddbItems).sort()).toEqual([ddbKey("BILL", marchSk), ddbKey("BILL_GUID", hresGuid)].sort());
      });

      it.each([
        ["more than 3 s after its storedAt", "2026-10-20T15:00:03.100Z", undefined],
        [
          "within 3 s but with another document's hash",
          "2026-10-20T15:00:01.100Z",
          "v1:0000000000000000:0000000000000000",
        ],
      ])("still skips an older document when the row is dated %s", async (_name, rowUpdatedAt, rowHash) => {
        const ddbItems = seedLegacyCeremonialRow(rowUpdatedAt);
        const rowSk = `${rowUpdatedAt}#${hresGuid}`;
        if (rowHash) ddbItems[ddbKey("BILL", rowSk)].contentHash = { S: rowHash };
        const before = JSON.parse(JSON.stringify(ddbItems));
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);

        const res = await loaded(hresEvent());

        expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSkipped: 1, upsertsSucceeded: 0 });
        expect(ddbItems).toEqual(before);
        expect(transactions(ddbSend)).toEqual([]);
      });

      it("relabels an existing row at its date when a newer version brings no news (a refetch)", async () => {
        const ddbItems = seedLegacyCeremonialRow();
        const { handler: loaded } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);
        s3.put(hresKey, { ...ceremonial, storedAt: "2026-10-27T12:00:00.000Z", cosponsors: ["C000001"] }, TEXT);

        const res = await loaded(hresEvent());

        expect(ddbItems[ddbKey("BILL_GUID", hresGuid)].manifestSk).toEqual({ S: ceremonialSk });
        expect(lifeAreasOf(ddbItems[ddbKey("BILL", ceremonialSk)])).toEqual([]);
        expect(topicsOf(ddbItems[ddbKey("BILL", ceremonialSk)])).toEqual([]);
        expect(JSON.parse(res.body).stats.upsertsKeptDate).toBe(1);
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ guid: hresGuid, decision: "kept", decidedBy: "previousVersion" }),
        ]);
      });

      it("still moves the row for a real action, and keeps it without life areas", async () => {
        const ddbItems = seedLegacyCeremonialRow();
        const { handler: loaded } = load(ddbItems);
        s3.put(hresKey, ceremonial, TEXT);
        const agreed = {
          ...ceremonial,
          storedAt: "2026-10-28T12:00:00.000Z",
          actions: [...ceremonial.actions, { actionDate: "2026-10-27", text: "Resolution agreed to in House" }],
        };
        s3.put(hresKey, agreed, TEXT);

        await loaded(hresEvent());

        const agreedSk = `${agreed.storedAt}#${hresGuid}`;
        expect(Object.keys(ddbItems).sort()).toEqual([ddbKey("BILL", agreedSk), ddbKey("BILL_GUID", hresGuid)].sort());
        expect(lifeAreasOf(ddbItems[ddbKey("BILL", agreedSk)])).toEqual([]);
        expect(topicsOf(ddbItems[ddbKey("BILL", agreedSk)])).toEqual([]);
        expect(ddbItems[ddbKey("BILL", agreedSk)].voteCount).toEqual({ N: "7" });
        expect(dateLines(info)).toEqual([
          expect.objectContaining({ guid: hresGuid, decision: "moved", moves: ["newerAction"] }),
        ]);
      });
    });

    describe("a document older than the one the row reflects never replaces it", () => {
      /** Two re-summaries of the same text, neither with news: each keeps the row at the base date. */
      const v1 = version({ title: "Caps Insulin Costs" });
      const V2_STORED_AT = "2026-10-12T08:00:00.000Z";
      const v2 = { ...base, storedAt: V2_STORED_AT, title: "Caps Insulin at $35", cosponsors: cosponsors(30) };
      /** The row this release wrote for v2: kept at the base date. */
      const seedKeptForV2 = () =>
        seedRow(v2, {
          updatedAt: base.storedAt,
          contentHash: billContentHash(v2),
          dateBasis: basisOf(v2),
          documentStoredAt: V2_STORED_AT,
          voteCount: "42",
        });

      it("cancels the slower of two kept writes when it holds the older version, which then leaves the newer", async () => {
        const ddbItems = seedCurrentRow(base, { voteCount: "42" });
        const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
        s3.put(key, base, TEXT);
        s3.put(key, v1, TEXT);
        const table = buildDdbMock(ddbItems);
        let raced = false;
        const inner: Array<{ body: string }> = [];
        ddbSend.mockImplementation(async (cmd: DdbCommand) => {
          if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
            raced = true;
            // Between this invocation's reads (of v1) and its commit, v2 lands and another invocation keeps it.
            s3.put(key, v2, TEXT);
            inner.push(await loaded(event()));
          }
          return table(cmd);
        });

        const res = await loaded(event());

        expect(JSON.parse(inner[0].body).stats).toMatchObject({ upsertsKeptDate: 1 });
        expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSkipped: 1, upsertsSucceeded: 0 });
        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
          updatedAt: { S: base.storedAt },
          title: { S: "Caps Insulin at $35" },
          contentHash: { S: billContentHash(v2) },
          dateBasis: { S: basisOf(v2) },
          documentStoredAt: { S: V2_STORED_AT },
          voteCount: { N: "42" },
        });
        expect(ddbItems[ddbKey("BILL", baseSk)].cosponsors.L).toHaveLength(30);
        // The skipped write is cancelled once (its kept put, conditioned on the row as read) and not tried again.
        const outer = transactions(ddbSend).filter(
          (cmd: TransactCommand) => cmd.input.TransactItems[0].Put?.Item?.title?.S === "Caps Insulin Costs",
        );
        expect(outer).toHaveLength(1);
        expect(outer[0].input.TransactItems[0].Put!.ExpressionAttributeValues).toMatchObject({
          ":observedContentHash": { S: billContentHash(base) },
          ":observedDocumentStoredAt": { S: base.storedAt },
        });
        // Both versions are still forwarded: only the row write is skipped.
        expect(sentTo(sqsSend, NOTIFY_QUEUE)).toHaveLength(2);
      });

      it("skips an S3 rollback's copy of an older version for a kept row, as for a moved one (RUNBOOK 5)", async () => {
        const ddbItems = seedKeptForV2();
        const before = JSON.parse(JSON.stringify(ddbItems));
        const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
        s3.put(key, base, TEXT);
        s3.put(key, v1, TEXT);
        s3.put(key, v2, TEXT);
        s3.put(key, v1, TEXT); // the copy keeps v1's storedAt, older than v2's

        const res = await loaded(event());

        expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSkipped: 1, upsertsSucceeded: 0 });
        expect(ddbItems).toEqual(before);
        expect(transactions(ddbSend)).toEqual([]);
        expect(dateLines(info)).toEqual([]);
        expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([{ bucket: { name: "test-bucket" }, object: { key } }]);
      });

      it("still rewrites an equal sort key in place: a repair that sets storedAt to the row's date", async () => {
        const ddbItems = seedKeptForV2();
        const lookupBefore = ddbItems[ddbKey("BILL_GUID", guid)];
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, base, TEXT);
        s3.put(key, v2, TEXT);
        // A repair writes a status at the row's own date, so the row is rewritten without a date decision.
        const aligned = { ...v2, storedAt: base.storedAt, billStatus: "Finalized" };
        s3.put(key, aligned, TEXT);

        await loaded(event());

        expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", baseSk), ddbKey("BILL_GUID", guid)].sort());
        expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
          updatedAt: { S: base.storedAt },
          billStatus: { S: "Finalized" },
          documentStoredAt: { S: base.storedAt },
          voteCount: { N: "42" },
        });
        expect(ddbItems[ddbKey("BILL_GUID", guid)]).toEqual(lookupBefore);
        expect(transactions(ddbSend)).toHaveLength(1);
        expect(dateLines(info)).toEqual([]);
      });
    });

    it("re-reads and keeps a vote count written between the read and the in-place put", async () => {
      const ddbItems = seedCurrentRow(base, { voteCount: "42" });
      const { handler: loaded, ddbSend } = load(ddbItems);
      s3.put(key, base, TEXT);
      s3.put(key, refill, TEXT);
      const table = buildDdbMock(ddbItems);
      let raced = false;
      ddbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          // billStatsAggregator lands a new count on the row first.
          ddbItems[ddbKey("BILL", baseSk)] = { ...ddbItems[ddbKey("BILL", baseSk)], voteCount: { N: "43" } };
        }
        return table(cmd);
      });

      const res = await loaded(event());

      expect(transactions(ddbSend)).toHaveLength(2);
      expect(ddbItems[ddbKey("BILL", baseSk)]).toMatchObject({
        voteCount: { N: "43" },
        updatedAt: { S: base.storedAt },
        contentHash: { S: billContentHash(refill) },
      });
      expect(JSON.parse(res.body).stats.upsertsKeptDate).toBe(1);
    });

    it("is cancelled and re-reads when another writer moved the lookup before the commit", async () => {
      const ddbItems = seedCurrentRow(base, { voteCount: "42" });
      const { handler: loaded, ddbSend } = load(ddbItems);
      s3.put(key, base, TEXT);
      s3.put(key, refill, TEXT);
      const newerSk = `2026-10-12T08:00:00.000Z#${guid}`;
      const table = buildDdbMock(ddbItems);
      let raced = false;
      ddbSend.mockImplementation((cmd: DdbCommand) => {
        if (cmd.__type === "TransactWriteItemsCommand" && !raced) {
          raced = true;
          // A newer version with news moved the row first; it has no vote count of its own to lose.
          const row = ddbItems[ddbKey("BILL", baseSk)];
          delete ddbItems[ddbKey("BILL", baseSk)];
          ddbItems[ddbKey("BILL", newerSk)] = {
            ...row,
            sk: { S: newerSk },
            updatedAt: { S: "2026-10-12T08:00:00.000Z" },
          };
          ddbItems[ddbKey("BILL_GUID", guid)] = { ...ddbItems[ddbKey("BILL_GUID", guid)], manifestSk: { S: newerSk } };
        }
        return table(cmd);
      });

      const res = await loaded(event());

      expect(transactions(ddbSend)).toHaveLength(1);
      expect(JSON.parse(res.body).stats).toMatchObject({ upsertsSkipped: 1, upsertsKeptDate: 0 });
      expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", newerSk), ddbKey("BILL_GUID", guid)].sort());
    });

    describe("the REL-50 status repair's write (repair:failed-status, RUNBOOK 4.11)", () => {
      const AMENDMENT = {
        actionDate: "2026-10-27",
        text: "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53.",
        type: "Floor",
      };
      /** A live bill the rule before REL-50 stamped Failed from an amendment line. */
      const stamped = (storedAt: string) => ({
        ...base,
        storedAt,
        actions: [AMENDMENT, ...base.actions],
        billStatus: "Failed",
      });
      const MARCH_ROW_AT = "2026-03-19T16:57:54.669Z"; // 0.754 s after its storedAt, as the March load dated rows

      const shapes: Array<[string, BillDoc, string, boolean]> = [
        ["a row at the bill's storedAt", stamped(base.storedAt), base.storedAt, true],
        ["a row whose date a version without news kept", stamped(BULK_STORED_AT), base.storedAt, true],
        ["a March row an older release dated after its storedAt", stamped(base.storedAt), MARCH_ROW_AT, false],
      ];

      it.each(shapes)(
        "rewrites %s in place with the new status, keeping its date and vote count",
        async (_n, doc, rowAt, current) => {
          const rowSk = `${rowAt}#${guid}`;
          const ddbItems = current
            ? seedRow(doc, {
                updatedAt: rowAt,
                contentHash: billContentHash(doc),
                dateBasis: basisOf(doc),
                documentStoredAt: doc.storedAt,
                voteCount: "7",
              })
            : seedRow(doc, { updatedAt: rowAt, voteCount: "7" });
          const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
          s3.put(key, doc, TEXT);
          const written = repairedDocument(doc, "New", rowAt);
          s3.put(key, written, TEXT);

          const res = await loaded(event());

          expect(rowKeys(ddbItems)).toEqual(
            [ddbKey("BILL", rowSk), ddbKey("BILL_GUID", guid), ddbKey("BILL_FORMERLY_FAILED", guid)].sort(),
          );
          // INT-11: the row leaves Failed, so the bill's marker commits with it (one transaction).
          expect(ddbItems[ddbKey("BILL_FORMERLY_FAILED", guid)]).toMatchObject({
            guid: { S: guid },
            statusLoweredTo: { S: "New" },
          });
          expect(transactions(ddbSend)).toHaveLength(1);
          expect(ddbItems[ddbKey("BILL", rowSk)]).toMatchObject({
            billStatus: { S: "New" },
            updatedAt: { S: rowAt },
            voteCount: { N: "7" },
            contentHash: { S: billContentHash(written) },
            dateBasis: { S: basisOf(written) },
            documentStoredAt: { S: rowAt },
          });
          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: rowSk });
          expect(JSON.parse(res.body).stats).toMatchObject({
            upsertsSucceeded: 1,
            upsertsSkipped: 0,
            upsertsKeptDate: 0,
          });
          expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Delete)).toBe(false);
          // The equal-key path: no date decision is made.
          expect(dateLines(info)).toEqual([]);
          // The key is forwarded as for any write; NotificationType sends nothing for a status-only version.
          expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([{ bucket: { name: "test-bucket" }, object: { key } }]);
        },
      );

      describe("a page-only write: the list row already New, the bill page Failed (H.J.Res. 139, S. 2882)", () => {
        // The March load wrote the row New, 0.657 s after its document and with no vote count. backfill:bill-status
        // stored Failed on 2026-04-07 at the March storedAt and without source metadata; the CreateBillsManifest of then
        // skipped that version as older than the row (existingSk > newSk), so only the page said Failed.
        const SUSPENSION = {
          actionCode: "9000",
          actionDate: "2026-03-18",
          text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the resolution Failed by the Yeas and Nays: (2/3 required): 211 - 207 (Roll no. 95).",
          type: "Floor",
        };
        const page = { ...base, actions: [SUSPENSION, ...base.actions], billStatus: "Failed" };
        const ROW_AT = "2026-03-19T16:57:54.572Z"; // 0.657 s after base.storedAt
        const rowSk = `${ROW_AT}#${guid}`;
        const listRow = () => {
          const ddbItems = seedRow({ ...page, billStatus: "New" }, { updatedAt: ROW_AT });
          delete ddbItems[ddbKey("BILL", rowSk)].voteCount;
          return ddbItems;
        };

        it("rewrites the row in place as it is: New, its date and key, no marker, no date decision", async () => {
          const ddbItems = listRow();
          const rowBefore = { ...ddbItems[ddbKey("BILL", rowSk)] };
          const lookupBefore = { ...ddbItems[ddbKey("BILL_GUID", guid)] };
          const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
          s3.put(key, page);
          const written = repairedDocument(page, "New", ROW_AT);
          const versionId = s3.put(key, written, { "correlation-id": "failed-status-rel50-20261030T030000Z" });

          const res = await loaded(event(versionId));

          // The served attributes as they were; the row gains what the document it now reflects stamps (never served).
          expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", rowSk), ddbKey("BILL_GUID", guid)].sort());
          expect(ddbItems[ddbKey("BILL", rowSk)]).toEqual({
            ...rowBefore,
            voteCount: { N: "0" },
            contentHash: { S: billContentHash(written) },
            dateBasis: { S: basisOf(written, null) },
            documentStoredAt: { S: ROW_AT },
          });
          expect(ddbItems[ddbKey("BILL_GUID", guid)]).toEqual(lookupBefore);
          const [transaction] = transactions(ddbSend);
          expect(transactions(ddbSend)).toHaveLength(1);
          expect(transaction.input.TransactItems.map((item: TransactOp) => Object.keys(item)[0])).toEqual([
            "Put",
            "Put",
          ]);
          // The row never said Failed: CreateBillsManifest writes no marker (the script's stays as it is).
          expect(info.mock.calls.filter(([message]) => message === "Marked a formerly failed bill")).toEqual([]);
          expect(dateLines(info)).toEqual([]);
          expect(JSON.parse(res.body).stats).toMatchObject({
            upsertsSucceeded: 1,
            upsertsSkipped: 0,
            upsertsKeptDate: 0,
          });
          expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([
            { bucket: { name: "test-bucket" }, object: { key, versionId } },
          ]);
          expect(sentTo(sqsSend, MEMBER_STATS_QUEUE)).toEqual([
            { bucket: { name: "test-bucket" }, object: { key, versionId } },
          ]);
        });

        it("would list the page's Failed if the unrepaired version were replayed now (a manifest rebuild)", async () => {
          const ddbItems = listRow();
          const { handler: loaded } = load(ddbItems);
          const versionId = s3.put(key, page);

          await loaded(event(versionId));

          // A March row is rewritten in place from its own version since 2026-10-28 (isRowsOwnVersion).
          expect(ddbItems[ddbKey("BILL", rowSk)]).toMatchObject({
            billStatus: { S: "Failed" },
            updatedAt: { S: ROW_AT },
          });
        });
      });

      it("would move the row to the time of the write, as status news, if the write kept the new storedAt", async () => {
        const doc = stamped(base.storedAt);
        const ddbItems = seedCurrentRow(doc);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, doc, TEXT);
        s3.put(key, { ...doc, storedAt: "2026-10-30T03:00:00.000Z", billStatus: "New" }, TEXT);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `2026-10-30T03:00:00.000Z#${guid}` });
        expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "moved", moves: ["status"] })]);
      });
    });

    describe("the REL-44 Finalized repair's write (repair:finalized-status, RUNBOOK 4.13)", () => {
      const LAW = {
        actionCode: "36000",
        actionDate: "2026-03-01",
        text: "Became Public Law No: 119-80.",
        type: "BecameLaw",
      };
      /** A law stored before REL-44, with the status the rule before it gave. */
      const law = (storedAt: string, billStatus = "Passed") => ({
        ...base,
        storedAt,
        actions: [LAW, ...base.actions],
        billStatus,
      });
      const MARCH_ROW_AT = "2026-03-19T16:57:54.669Z"; // 0.754 s after its storedAt, as the March load dated rows

      const shapes: Array<[string, ReturnType<typeof law>, string, boolean]> = [
        ["a row at the bill's storedAt", law(base.storedAt), base.storedAt, true],
        ["a row whose date a version without news kept", law(BULK_STORED_AT), base.storedAt, true],
        ["a March row an older release dated after its storedAt", law(base.storedAt), MARCH_ROW_AT, false],
      ];

      it.each(shapes)(
        "rewrites %s in place as Finalized, keeping its date and vote count, with no marker",
        async (_n, doc, rowAt, current) => {
          const rowSk = `${rowAt}#${guid}`;
          const ddbItems = current
            ? seedRow(doc, {
                updatedAt: rowAt,
                contentHash: billContentHash(doc),
                dateBasis: basisOf(doc),
                documentStoredAt: doc.storedAt,
                voteCount: "7",
              })
            : seedRow(doc, { updatedAt: rowAt, voteCount: "7" });
          const { handler: loaded, ddbSend, sqsSend } = load(ddbItems);
          s3.put(key, doc, TEXT);
          const written = finalizedDocument(doc, rowAt);
          s3.put(key, written, TEXT);

          const res = await loaded(event());

          // A Passed row does not leave Failed: no "formerly failed" marker.
          expect(rowKeys(ddbItems)).toEqual([ddbKey("BILL", rowSk), ddbKey("BILL_GUID", guid)].sort());
          expect(ddbItems[ddbKey("BILL", rowSk)]).toMatchObject({
            billStatus: { S: "Finalized" },
            updatedAt: { S: rowAt },
            voteCount: { N: "7" },
            contentHash: { S: billContentHash(written) },
            dateBasis: { S: basisOf(written) },
            documentStoredAt: { S: rowAt },
          });
          expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: rowSk });
          expect(JSON.parse(res.body).stats).toMatchObject({
            upsertsSucceeded: 1,
            upsertsSkipped: 0,
            upsertsKeptDate: 0,
          });
          expect(transactions(ddbSend)).toHaveLength(1);
          expect(transactions(ddbSend)[0].input.TransactItems.some((item: { Delete?: unknown }) => item.Delete)).toBe(
            false,
          );
          // The equal-key path: no date decision is made.
          expect(dateLines(info)).toEqual([]);
          // The key is forwarded as for any write; NotificationType sends nothing for a status-only version.
          expect(sentTo(sqsSend, NOTIFY_QUEUE)).toEqual([{ bucket: { name: "test-bucket" }, object: { key } }]);
        },
      );

      it("marks a law stored Failed in the transaction that rewrites its row as Finalized (REL-50, INT-11)", async () => {
        const doc = law(base.storedAt, "Failed");
        const ddbItems = seedCurrentRow(doc);
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, doc, TEXT);
        s3.put(key, finalizedDocument(doc, base.storedAt), TEXT);

        await loaded(event());

        expect(ddbItems[ddbKey("BILL", `${base.storedAt}#${guid}`)].billStatus).toEqual({ S: "Finalized" });
        expect(ddbItems[ddbKey("BILL_FORMERLY_FAILED", guid)]).toMatchObject({ statusLoweredTo: { S: "Finalized" } });
        expect(transactions(ddbSend)).toHaveLength(1);
      });

      it("would move the row to the time of the write, as status news, if the write kept the new storedAt", async () => {
        const doc = law(base.storedAt);
        const ddbItems = seedCurrentRow(doc);
        const { handler: loaded } = load(ddbItems);
        s3.put(key, doc, TEXT);
        s3.put(key, { ...doc, storedAt: "2026-11-10T03:00:00.000Z", billStatus: "Finalized" }, TEXT);

        await loaded(event());

        // As billDiffer's live write of a new law does: becoming law is news.
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `2026-11-10T03:00:00.000Z#${guid}` });
        expect(dateLines(info)).toEqual([expect.objectContaining({ decision: "moved", moves: ["status"] })]);
      });
    });

    describe("the formerly failed marker (REL-50, INT-11): a row that leaves Failed for an open status", () => {
      const AMENDMENT = {
        actionDate: "2026-10-27",
        text: "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53.",
        type: "Floor",
      };
      const PASSAGE = {
        actionCode: "17000",
        actionDate: "2026-10-28",
        text: "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 60 - 40.",
        type: "Floor",
      };
      const failed = { ...base, actions: [AMENDMENT, ...base.actions], billStatus: "Failed" };
      const LOWERED_AT = "2026-11-02T14:05:00.000Z";
      const markerKey = ddbKey("BILL_FORMERLY_FAILED", guid);

      it("marks the bill in the transaction that writes billDiffer's New, when the row moves as status news", async () => {
        const ddbItems = seedCurrentRow(failed, { voteCount: "4" });
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, failed, TEXT);
        s3.put(key, { ...failed, storedAt: LOWERED_AT, billStatus: "New" }, TEXT);

        await loaded(event());

        const [transaction] = transactions(ddbSend);
        expect(transaction.input.TransactItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              Update: expect.objectContaining({ Key: { pk: { S: "BILL_FORMERLY_FAILED" }, sk: { S: guid } } }),
            }),
          ]),
        );
        expect(ddbItems[markerKey]).toMatchObject({
          pk: { S: "BILL_FORMERLY_FAILED" },
          sk: { S: guid },
          guid: { S: guid },
          statusLoweredTo: { S: "New" },
        });
        expect(ddbItems[markerKey].markedAt).toEqual(ddbItems[markerKey].statusLoweredAt);
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `${LOWERED_AT}#${guid}` });
        expect(info.mock.calls).toContainEqual(["Marked a formerly failed bill", { guid, statusLoweredTo: "New" }]);
      });

      it("keeps the first markedAt when the bill was marked before (repair:failed-status)", async () => {
        const ddbItems: Items = {
          ...seedCurrentRow(failed),
          [markerKey]: {
            pk: { S: "BILL_FORMERLY_FAILED" },
            sk: { S: guid },
            guid: { S: guid },
            rule: { S: "REL-50" },
            markedAt: { S: "2026-11-01T09:00:00.000Z" },
          },
        };
        const { handler: loaded } = load(ddbItems);
        s3.put(key, failed, TEXT);
        s3.put(key, { ...failed, storedAt: LOWERED_AT, billStatus: "New" }, TEXT);

        await loaded(event());

        expect(ddbItems[markerKey]).toMatchObject({
          rule: { S: "REL-50" },
          markedAt: { S: "2026-11-01T09:00:00.000Z" },
          statusLoweredTo: { S: "New" },
        });
      });

      it.each<[string, BillDoc, Partial<BillDoc>]>([
        [
          "Failed to Passed (still listed with Dismiss)",
          failed,
          { actions: [PASSAGE, AMENDMENT, ...base.actions], billStatus: "Passed" },
        ],
        ["New to New", base, { soWhat: "Seniors would pay less for insulin and inhalers." }],
        [
          "New to Failed",
          base,
          { actions: [{ ...PASSAGE, actionCode: "18000" }, ...base.actions], billStatus: "Failed" },
        ],
        ["Failed to Failed", failed, { soWhat: "Seniors would pay less for insulin and inhalers." }],
      ])("writes no marker for %s", async (_name, before, changes) => {
        const ddbItems = seedCurrentRow(before);
        const { handler: loaded, ddbSend } = load(ddbItems);
        s3.put(key, before, TEXT);
        s3.put(key, { ...before, storedAt: LOWERED_AT, ...changes }, TEXT);

        await loaded(event());

        expect(ddbItems[markerKey]).toBeUndefined();
        expect(transactions(ddbSend)).toHaveLength(1);
        expect(transactions(ddbSend)[0].input.TransactItems.some((item: TransactOp) => item.Update)).toBe(false);
      });

      it("writes neither the row nor the marker when the transaction is cancelled, and both on the retry", async () => {
        const ddbItems = seedCurrentRow(failed);
        const { handler: loaded, ddbSend } = load(ddbItems);
        const mock = buildDdbMock(ddbItems);
        let cancelled = false;
        ddbSend.mockImplementation((cmd: DdbCommand) => {
          if (cmd.__type === "TransactWriteItemsCommand" && !cancelled) {
            cancelled = true;
            throw transactionCanceled(cmd.input.TransactItems!.map(() => "ConditionalCheckFailed"));
          }
          return mock(cmd);
        });
        s3.put(key, failed, TEXT);
        s3.put(key, { ...failed, storedAt: LOWERED_AT, billStatus: "New" }, TEXT);

        await loaded(event());

        expect(transactions(ddbSend)).toHaveLength(2);
        expect(ddbItems[markerKey]).toMatchObject({ statusLoweredTo: { S: "New" } });
        expect(ddbItems[ddbKey("BILL_GUID", guid)].manifestSk).toEqual({ S: `${LOWERED_AT}#${guid}` });
      });
    });
  });
});

export {};
