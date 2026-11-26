import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { applyTestEnv } from "./fixtures/env";

// UX-47, UX-35: both apps save a Bill row (PUT /preferences type=bill) after every stored vote, on the same key
// (user, plain guid) as the bill's Watch row. A vote must not turn a Watch row into a Bill row, and unwatching a bill
// the user voted on must leave them the Bill row, so the voter keeps the pushes a vote gives.

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: mockSend })), __mockSend: mockSend };
});

type Item = Record<string, AttributeValue>;
interface FakeCommand {
  constructor: { name: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
}

const PREFERENCES = "UserPreferences";
const FEEDBACK = "UserFeedback";
const PII = "UserPII";
const USER = "user-1";
const BILL = "BILLS-119hr1181";
const OTHER_BILL = "BILLS-119s570";

const restoreEnv = applyTestEnv({
  TABLE_NAME: PREFERENCES,
  PARTITION_KEY: "userId",
  SORT_KEY: "preference",
  PII_TABLE_NAME: PII,
  PII_PARTITION_KEY: "userId",
  FEEDBACK_TABLE_NAME: FEEDBACK,
  FEEDBACK_PARTITION_KEY: "userId",
  FEEDBACK_SORT_KEY: "billId",
});
afterAll(() => restoreEnv());

const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb") as { __mockSend: jest.Mock };
const { handler: setPreferences } = require("../handlers/setPreferences");
const { handler: deletePreferences } = require("../handlers/deletePreferences");

/** The user's preference rows, by sort key (`preference`), and their vote rows, by bill id. */
let preferences: Map<string, Item>;
let votes: Map<string, Item>;
/** Runs before a command is applied, so a test can interleave another request there. */
let beforeApply: (command: FakeCommand) => Promise<void>;

const conditionalCheckFailed = () =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

/** The one condition setPreferences and deletePreferences put on a Bill row: the stored row is no Watch row. */
const putAllowed = (input: { ConditionExpression?: string; ExpressionAttributeValues?: Item }, stored?: Item) => {
  if (!input.ConditionExpression) return true;
  expect(input.ConditionExpression).toBe("attribute_not_exists(#type) OR NOT (#type IN (:watch, :watchLower))");
  const watchTypes = [input.ExpressionAttributeValues![":watch"].S, input.ExpressionAttributeValues![":watchLower"].S];
  return stored?.type?.S === undefined || !watchTypes.includes(stored.type.S);
};

const fakeTable = async (command: FakeCommand): Promise<unknown> => {
  await beforeApply(command);
  const input = command.input;
  switch (command.constructor.name) {
    case "GetItemCommand":
      expect(input.TableName).toBe(PII);
      return { Item: { userId: { S: USER }, adultStatus: { S: "attested_adult" } } };
    case "BatchWriteItemCommand": {
      for (const request of input.RequestItems[PREFERENCES]) {
        if (request.PutRequest) preferences.set(request.PutRequest.Item.preference.S, request.PutRequest.Item);
        if (request.DeleteRequest) preferences.delete(request.DeleteRequest.Key.preference.S);
      }
      return {};
    }
    case "PutItemCommand": {
      expect(input.TableName).toBe(PREFERENCES);
      const key = input.Item.preference.S;
      if (!putAllowed(input, preferences.get(key))) throw conditionalCheckFailed();
      preferences.set(key, input.Item);
      return {};
    }
    case "QueryCommand": {
      expect(input.TableName).toBe(PREFERENCES);
      const prefix = input.ExpressionAttributeValues[":plainGuid"].S;
      return { Items: [...preferences.values()].filter((item) => item.preference.S!.startsWith(prefix)) };
    }
    case "BatchGetItemCommand": {
      const request = input.RequestItems[FEEDBACK];
      expect(request.ConsistentRead).toBe(true);
      const rows = request.Keys.map((key: Item) => {
        expect(key.userId.S).toBe(USER);
        return votes.get(key.billId.S!);
      }).filter(Boolean);
      return { Responses: { [FEEDBACK]: rows } };
    }
    default:
      throw new Error(`Unexpected ${command.constructor.name}`);
  }
};

const event = (body: unknown) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: USER } } } },
  body: JSON.stringify(body),
});
const put = (body: unknown) => setPreferences(event(body));
const unwatch = (body: unknown) => deletePreferences(event(body));
const bill = (guid: string) => ({ preference: guid, type: "bill", category: "" });
const watch = (guid: string) => ({ preference: guid, type: "watch", category: "" });
const typeOf = (key: string) => preferences.get(key)?.type?.S;
const commandsNamed = (name: string) =>
  send.mock.calls.map(([command]: [FakeCommand]) => command).filter((command) => command.constructor.name === name);
const storeRow = (preference: string, type: string, category?: string) =>
  preferences.set(preference, {
    userId: { S: USER },
    preference: { S: preference },
    type: { S: type },
    ...(category ? { category: { S: category } } : {}),
  });
const vote = (billId: string, feedback: string, extra: Item = {}) =>
  votes.set(billId, { userId: { S: USER }, billId: { S: billId }, feedback: { S: feedback }, ...extra });

let infoLines: jest.SpyInstance;
beforeEach(() => {
  infoLines = jest.spyOn(console, "log").mockImplementation(() => undefined);
  send.mockReset();
  send.mockImplementation(fakeTable);
  preferences = new Map();
  votes = new Map();
  beforeApply = async () => undefined;
});

afterEach(() => infoLines.mockRestore());

describe("a vote's Bill row keeps the bill's Watch row (UX-47)", () => {
  it("leaves a watched bill's Watch row as it is", async () => {
    storeRow(BILL, "Watch");

    const response = await put(bill(BILL));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ message: "Preferences updated", count: 1 });
    expect(typeOf(BILL)).toBe("Watch");
    expect(commandsNamed("BatchWriteItemCommand")).toHaveLength(0);
  });

  it("keeps a Watch row an older build stored with a lowercase type", async () => {
    storeRow(BILL, "watch");

    expect((await put(bill(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("watch");
  });

  it("writes a Bill row on a bill the user does not watch, and over an earlier Bill row", async () => {
    expect((await put(bill(BILL))).statusCode).toBe(200);
    expect(preferences.get(BILL)).toEqual({ userId: { S: USER }, preference: { S: BILL }, type: { S: "Bill" } });

    expect((await put(bill(`${BILL}rh`))).statusCode).toBe(200);
    expect([...preferences.keys()]).toEqual([BILL]);
    expect(typeOf(BILL)).toBe("Bill");
  });

  it("lets a watch saved after the vote replace the Bill row", async () => {
    await put(bill(BILL));
    await put(watch(BILL));

    expect(typeOf(BILL)).toBe("Watch");
  });

  describe("a watch and a vote saved at the same moment", () => {
    it("keeps the watch when it lands between the vote's request and its write", async () => {
      // The Bill request is held after its eligibility read; the watch is stored before its PutItem runs.
      let releaseBill!: () => void;
      const billHeld = new Promise<void>((resolve) => (releaseBill = resolve));
      beforeApply = async (command) => {
        if (command.constructor.name === "PutItemCommand") await billHeld;
      };

      const voteWrite = put(bill(BILL));
      await new Promise((resolve) => setImmediate(resolve));
      expect((await put(watch(BILL))).statusCode).toBe(200);
      expect(typeOf(BILL)).toBe("Watch");
      releaseBill();

      expect((await voteWrite).statusCode).toBe(200);
      expect(typeOf(BILL)).toBe("Watch");
    });

    it("keeps the watch whichever write lands first, sent together", async () => {
      for (const order of [
        [bill(BILL), watch(BILL)],
        [watch(BILL), bill(BILL)],
      ]) {
        preferences = new Map();
        const responses = await Promise.all(order.map((body) => put(body)));

        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        expect(typeOf(BILL)).toBe("Watch");
      }
    });
  });

  it("writes the other types of a mixed body in one BatchWriteItem and each Bill row on its own", async () => {
    storeRow(BILL, "Watch");

    const response = await put([
      bill(BILL),
      { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
      bill(OTHER_BILL),
      watch("BILLS-119hr77"),
      { preference: "Taxes", type: "Life Area" },
    ]);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ message: "Preferences updated", count: 5 });
    const batches = commandsNamed("BatchWriteItemCommand");
    expect(batches).toHaveLength(1);
    expect(
      batches[0].input.RequestItems[PREFERENCES].map((request: { PutRequest: { Item: Item } }) => [
        request.PutRequest.Item.preference.S,
        request.PutRequest.Item.type.S,
      ]),
    ).toEqual([
      ["Energy", "Category"],
      ["BILLS-119hr77", "Watch"],
      ["Taxes", "Life Area"],
    ]);
    expect(commandsNamed("PutItemCommand").map((command) => command.input.Item.preference.S)).toEqual([
      BILL,
      OTHER_BILL,
    ]);
    expect(typeOf(BILL)).toBe("Watch");
    expect(typeOf(OTHER_BILL)).toBe("Bill");
  });

  it("writes a bill named as both a Bill and a Watch in one body as the Watch, in either order", async () => {
    for (const body of [
      [watch(BILL), bill(BILL)],
      [bill(BILL), watch(BILL)],
    ]) {
      preferences = new Map();
      expect((await put(body)).statusCode).toBe(200);
      expect(typeOf(BILL)).toBe("Watch");
    }
  });

  it("answers 500 when a Bill row write fails for another reason", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    beforeApply = async (command) => {
      if (command.constructor.name === "PutItemCommand") {
        throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      }
    };

    expect((await put(bill(BILL))).statusCode).toBe(500);
    errors.mockRestore();
  });
});

describe("unwatching a bill the user voted on keeps their Bill row (UX-47)", () => {
  it("turns the Watch row into the Bill row a vote saves", async () => {
    storeRow(BILL, "Watch");
    vote(BILL, "Yea");

    const response = await unwatch(watch(BILL));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ message: "Preferences deleted", count: 1 });
    expect(preferences.get(BILL)).toEqual({ userId: { S: USER }, preference: { S: BILL }, type: { S: "Bill" } });
    expect(infoLines.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ message: "Unwatched bills keep the voter's Bill row", restored: 1 }),
    ]);
  });

  it("puts back the Bill row a vote turned the watch into before this fix, when the app unwatches it", async () => {
    storeRow(BILL, "Bill");
    vote(BILL, "Abstain");

    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Bill");
  });

  it("deletes the row of a bill the user did not vote on, or only dismissed in 1.0 or 1.1", async () => {
    storeRow(BILL, "Watch");
    storeRow(OTHER_BILL, "Watch");
    vote(OTHER_BILL, "Abstain", { legacyDismiss: { BOOL: true } });

    expect((await unwatch([watch(BILL), watch(OTHER_BILL)])).statusCode).toBe(200);
    expect([...preferences.keys()]).toEqual([]);
    expect(commandsNamed("PutItemCommand")).toHaveLength(0);
  });

  it("reads the vote under every spelling and keeps one Bill row under the plain guid", async () => {
    storeRow(BILL, "Watch");
    storeRow(`${BILL}rh`, "Bill");
    vote(`${BILL}rh`, "Nay");

    expect((await unwatch(watch(`${BILL}ih`))).statusCode).toBe(200);
    expect([...preferences.keys()]).toEqual([BILL]);
    expect(typeOf(BILL)).toBe("Bill");
    const keysRead = commandsNamed("BatchGetItemCommand").flatMap((command) =>
      command.input.RequestItems[FEEDBACK].Keys.map((key: Item) => key.billId.S),
    );
    expect(keysRead.sort()).toEqual([BILL, `${BILL}ih`, `${BILL}rh`].sort());
  });

  it("keeps a watch saved again while the unwatch reads the votes", async () => {
    storeRow(BILL, "Watch");
    vote(BILL, "Yea");
    beforeApply = async (command) => {
      if (command.constructor.name === "BatchGetItemCommand") storeRow(BILL, "Watch");
    };

    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Watch");
  });

  it("keeps the Bill row of a vote saved while the unwatch runs, read or not", async () => {
    // The vote is stored after the unwatch's delete and before its read: the read finds it.
    storeRow(BILL, "Watch");
    beforeApply = async (command) => {
      if (command.constructor.name === "BatchGetItemCommand") vote(BILL, "Yea");
    };
    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Bill");

    // The vote is stored after the read: the app's Bill row, sent once the vote is stored, finds no Watch row.
    preferences = new Map();
    votes = new Map();
    storeRow(BILL, "Watch");
    beforeApply = async () => undefined;
    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(preferences.has(BILL)).toBe(false);
    vote(BILL, "Yea");
    expect((await put(bill(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Bill");
  });

  it("reads no votes for an unwatch of no bill, and deletes a Bill row asked for by type as before", async () => {
    storeRow("Energy", "Category", "Environmental and Energy Policy");
    storeRow(OTHER_BILL, "Bill");
    vote(OTHER_BILL, "Yea");

    const response = await unwatch([
      { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
      bill(OTHER_BILL),
    ]);

    expect(response.statusCode).toBe(200);
    expect([...preferences.keys()]).toEqual([]);
    expect(commandsNamed("BatchGetItemCommand")).toHaveLength(0);
  });

  it("retries unprocessed vote keys, and answers 500 when they stay unprocessed, so the app keeps the watch", async () => {
    storeRow(BILL, "Watch");
    vote(BILL, "Yea");
    let unprocessedAnswers = 1;
    send.mockImplementation(async (command: FakeCommand) => {
      if (command.constructor.name === "BatchGetItemCommand" && unprocessedAnswers > 0) {
        unprocessedAnswers -= 1;
        return { Responses: { [FEEDBACK]: [] }, UnprocessedKeys: { [FEEDBACK]: command.input.RequestItems[FEEDBACK] } };
      }
      return fakeTable(command);
    });

    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Bill");

    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    storeRow(BILL, "Watch");
    unprocessedAnswers = 4;
    expect((await unwatch(watch(BILL))).statusCode).toBe(500);
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Could not read the caller's votes after an unwatch",
    );
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(USER);

    errors.mockRestore();

    // The app keeps the watch and sends the unwatch again: that one puts the Bill row back.
    expect((await unwatch(watch(BILL))).statusCode).toBe(200);
    expect(typeOf(BILL)).toBe("Bill");
  });
});
