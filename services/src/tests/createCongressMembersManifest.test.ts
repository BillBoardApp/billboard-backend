process.env.BUCKET_NAME = "test-bucket"; // set before imports
process.env.TABLE_NAME = "test-table";
process.env.PRIMARY_KEY = "id";
import { handler } from "../handlers/createCongressMembersManifest";
import { jsonReadable } from "./fixtures/streams";
import { asSqsEvent, sqsWrappedS3Keys } from "./fixtures/awsEvents";
import { applyTestEnv } from "./fixtures/env";

/** An attribute map as the handler writes it; the tests read only S. */
type DdbItem = Record<string, { S?: string; NULL?: boolean }>;

/** An S3 command as the mocked SDK constructors build it; the input fields are the ones the fake reads. */
interface FakeS3Command {
  __type?: string;
  input?: { Body?: unknown; Key?: string; Prefix?: string };
}

/** A DynamoDB command as the mocked SDK constructors build it. */
interface FakeDdbCommand {
  __type?: string;
  input?: { Item?: DdbItem; Key?: DdbItem };
}

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
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
    DeleteItemCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteItemCommand", input })),
  };
});

describe("createCongressMembersManifest handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-s3");
  const { __mockSend: mockDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      TABLE_NAME: "test-table",
      PRIMARY_KEY: "id",
    });
  });

  afterEach(() => {
    restoreEnv?.();
    jest.useRealTimers();
  });

  it("processes SQS-wrapped S3 event records", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const memberA = {
      member: {
        bioguideId: "A000001",
        directOrderName: "Alice Example",
        firstName: "Alice",
        lastName: "Example",
        termCount: 1,
        partyAbbreviation: "D",
        partyName: "Democrat",
        state: "California",
        chamber: "Senate",
        congress: 119,
        district: null,
        memberType: "Senator",
        startYear: 2025,
        stateCode: "CA",
        stateName: "California",
        updateDate: "2025-01-03T00:00:00Z",
        cosponsoredLegislationCount: 0,
        sponsoredLegislationCount: 0,
        depictionImageUrl: null,
      },
    };

    const streamA = jsonReadable(memberA);

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    const ddbItems: Record<string, DdbItem> = {};
    setupS3MockRequestAware(mockSend, (cmd: FakeS3Command) => {
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
      if (name === "GetObjectCommand" && input.Key === "processed-congress-members/A000001.json") {
        return { Body: streamA, LastModified: new Date().toISOString() };
      }
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd.input || {};
      if (cmd.__type === "PutItemCommand") {
        const pk = input.Item?.id?.S;
        if (!pk) throw new Error("Missing PK on PutItem");
        ddbItems[pk] = input.Item!;
        return {};
      }
      if (cmd.__type === "DeleteItemCommand") {
        const pk = input.Key?.id?.S;
        if (pk) delete ddbItems[pk];
        return {};
      }
      throw new Error("Unexpected DDB request: " + cmd.__type + " " + JSON.stringify(input));
    });

    const sqsEvent = sqsWrappedS3Keys(["processed-congress-members/A000001.json"]);

    const res = await handler(sqsEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.addedOrUpdated).toBe(1);
    expect(body.deleted).toBe(0);

    const items = Object.values(ddbItems);
    expect(items).toHaveLength(1);
    const stored = items[0];
    expect(stored.id.S).toBe("A000001");
    expect(stored.updatedAt.S).toBe("2026-01-08T22:47:57.000Z");
    expect(Object.prototype.hasOwnProperty.call(stored, "depictionImageUrl")).toBe(true);
  });

  it("uses If-Match when manifest exists", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const ddbItems: Record<string, DdbItem> = {
      A000001: {
        id: { S: "A000001" },
        bioguideId: { S: "A000001" },
        name: { S: "Alice Example" },
        chamber: { S: "Senate" },
        state: { S: "CA" },
        party: { S: "D" },
        district: { NULL: true },
        depictionImageUrl: { NULL: true },
        updatedAt: { S: "2026-01-01T00:00:00.000Z" },
      },
    };

    const memberA = {
      member: {
        bioguideId: "A000001",
        directOrderName: "Alice Example",
        firstName: "Alice",
        lastName: "Example",
        termCount: 1,
        partyAbbreviation: "D",
        partyName: "Democrat",
        state: "California",
        chamber: "Senate",
        congress: 119,
        district: null,
        memberType: "Senator",
        startYear: 2025,
        stateCode: "CA",
        stateName: "California",
        updateDate: "2025-01-03T00:00:00Z",
        cosponsoredLegislationCount: 0,
        sponsoredLegislationCount: 0,
        depictionImageUrl: null,
      },
    };

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    setupS3MockRequestAware(mockSend, (cmd: FakeS3Command) => {
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
      if (name === "GetObjectCommand" && input.Key === "processed-congress-members/A000001.json") {
        return { Body: jsonReadable(memberA) };
      }
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd.input || {};
      if (cmd.__type === "PutItemCommand") {
        const pk = input.Item?.id?.S;
        if (!pk) throw new Error("Missing PK on PutItem");
        ddbItems[pk] = input.Item!;
        return {};
      }
      if (cmd.__type === "DeleteItemCommand") {
        const pk = input.Key?.id?.S;
        if (pk) delete ddbItems[pk];
        return {};
      }
      throw new Error("Unexpected DDB request: " + cmd.__type + " " + JSON.stringify(input));
    });

    const res = await handler(sqsWrappedS3Keys(["processed-congress-members/A000001.json"]));
    expect(res.statusCode).toBe(200);
    const items = Object.values(ddbItems);
    expect(items).toHaveLength(1);
    const stored = items[0];
    expect(stored.updatedAt.S).toBe("2026-01-08T22:47:57.000Z");
  });

  it("ignores events for the manifest key (prevents feedback loop)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-08T22:47:57.000Z"));

    const { setupS3MockRequestAware } = require("./s3RequestMock");
    setupS3MockRequestAware(mockSend, (cmd: FakeS3Command) => {
      const input = cmd.input || {};
      const name = cmd.__type;
      if (name === "ListObjectsV2Command") throw new Error("Should not list objects");
      throw new Error("Unexpected S3 request: " + name + " " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd.input || {};
      if (cmd.__type === "PutItemCommand") {
        throw new Error("Should not write member items for non-processed-congress-members keys");
      }
      if (cmd.__type === "DeleteItemCommand") {
        throw new Error("Should not delete member items for non-processed-congress-members keys");
      }
      throw new Error("Unexpected DDB request: " + cmd.__type + " " + JSON.stringify(input));
    });

    const res = await handler(sqsWrappedS3Keys(["congress-members-manifest.json"]));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).updated).toBe(false);
    expect(JSON.parse(res.body).addedOrUpdated).toBe(0);
    expect(JSON.parse(res.body).deleted).toBe(0);
  });
  describe("per-record failures and departed members (REL-15, APPF-02)", () => {
    const { noSuchKeyError } = require("./fixtures/awsErrors");

    const processedMember = (bioguideId: string, name: string, district: number) => ({
      member: {
        bioguideId,
        directOrderName: name,
        partyAbbreviation: "R",
        chamber: "House of Representatives",
        district,
        stateCode: "GA",
        stateName: "Georgia",
        updateDate: "2026-01-06T00:00:00Z",
      },
    });

    const s3Event = (entries: Array<{ messageId: string; key: string; eventName?: string }>) =>
      asSqsEvent({
        Records: entries.map(({ messageId, key, eventName }) => ({
          messageId,
          body: JSON.stringify({
            Records: [{ eventName: eventName ?? "ObjectCreated:Put", s3: { object: { key } } }],
          }),
        })),
      });

    let ddbItems: Record<string, DdbItem>;

    beforeEach(() => {
      jest.spyOn(console, "warn").mockImplementation();
      jest.spyOn(console, "error").mockImplementation();
      ddbItems = {};
      mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
        const input = cmd.input || {};
        if (cmd.__type === "PutItemCommand") {
          ddbItems[input.Item!.id.S!] = input.Item!;
          return {};
        }
        if (cmd.__type === "DeleteItemCommand") {
          delete ddbItems[input.Key!.id.S!];
          return {};
        }
        throw new Error("Unexpected DDB request: " + cmd.__type);
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("reports a record whose S3 read failed and still applies the rest of the batch", async () => {
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, (cmd: FakeS3Command) => {
        const key = cmd.input?.Key;
        if (key === "processed-congress-members/B000002.json") {
          throw Object.assign(new Error("SlowDown"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
        }
        if (key === "processed-congress-members/A000001.json") {
          return { Body: jsonReadable(processedMember("A000001", "Alice Example", 1)) };
        }
        throw new Error("Unexpected S3 request: " + JSON.stringify(cmd.input));
      });

      const res = await handler(
        s3Event([
          { messageId: "m-fail", key: "processed-congress-members/B000002.json" },
          { messageId: "m-ok", key: "processed-congress-members/A000001.json" },
        ]),
      );

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-fail" }]);
      expect(Object.keys(ddbItems)).toEqual(["A000001"]);
      expect(JSON.parse(res.body)).toEqual(expect.objectContaining({ addedOrUpdated: 1, failedRecords: 1 }));
    });

    it("reports a record whose manifest write failed", async () => {
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, () => ({ Body: jsonReadable(processedMember("A000001", "Alice Example", 1)) }));
      mockDdbSend.mockRejectedValueOnce(Object.assign(new Error("Throttled"), { name: "ThrottlingException" }));

      const res = await handler(s3Event([{ messageId: "m1", key: "processed-congress-members/A000001.json" }]));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
    });

    it("skips, without failing, an object that was deleted before the event was handled", async () => {
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, () => {
        throw noSuchKeyError();
      });

      const res = await handler(s3Event([{ messageId: "m1", key: "processed-congress-members/G000596.json" }]));

      expect(res.batchItemFailures).toEqual([]);
      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    it("leaves only the successor in a seat once the departed member's object is removed", async () => {
      // GA-14 held by both the departed member and the successor, as in the live manifest.
      ddbItems = {
        G000596: { id: { S: "G000596" }, bioguideId: { S: "G000596" }, state: { S: "GA" }, district: { S: "14" } },
        S000999: { id: { S: "S000999" }, bioguideId: { S: "S000999" }, state: { S: "GA" }, district: { S: "14" } },
      };
      const { setupS3MockRequestAware } = require("./s3RequestMock");
      setupS3MockRequestAware(mockSend, (cmd: FakeS3Command) => {
        if (cmd.input?.Key === "processed-congress-members/S000999.json") {
          return { Body: jsonReadable(processedMember("S000999", "Successor Example", 14)) };
        }
        throw new Error("Unexpected S3 request: " + JSON.stringify(cmd.input));
      });

      const res = await handler(
        s3Event([
          {
            messageId: "m-removed",
            key: "processed-congress-members/G000596.json",
            eventName: "ObjectRemoved:DeleteMarkerCreated",
          },
          { messageId: "m-successor", key: "processed-congress-members/S000999.json" },
        ]),
      );

      expect(res.batchItemFailures).toEqual([]);
      expect(Object.keys(ddbItems)).toEqual(["S000999"]);
      expect(ddbItems.S000999.district).toEqual({ S: "14" });
      expect(JSON.parse(res.body)).toEqual(expect.objectContaining({ addedOrUpdated: 1, deleted: 1 }));
    });
  });
});

export {};
