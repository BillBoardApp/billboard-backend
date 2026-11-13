import { APP_ATTEST_BINDING_TTL_SECONDS, APP_ATTEST_KEY_TTL_SECONDS } from "../shared/abuseLimits";
import {
  AppAttestStore,
  bindingItemKey,
  challengeItemKey,
  keyItemKey,
  userPartitionKey,
} from "../shared/appAttest/store";
import { FakeAppAttestTable, challengeOf, challengeRow, keyRow } from "./fixtures/appAttest/helpers";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const CHALLENGE = challengeOf("store");
const KEY_ID = "iInD91fLmBNJf1uM35LYM2FQ9DOE3FNDPD-tKlX7pkw";

let table: FakeAppAttestTable;
let store: AppAttestStore;

beforeEach(() => {
  table = new FakeAppAttestTable();
  store = new AppAttestStore("AppAttest", table);
});

describe("keys", () => {
  it("lays out the items of C3 4.1", () => {
    expect(challengeItemKey("c")).toEqual({ pk: { S: "CH#c" }, sk: { S: "CH" } });
    expect(keyItemKey("k")).toEqual({ pk: { S: "KEY#k" }, sk: { S: "META" } });
    expect(bindingItemKey("sub-1", "k")).toEqual({ pk: { S: "USER#sub-1" }, sk: { S: "KEY#k" } });
    expect(userPartitionKey("sub-1")).toBe("USER#sub-1");
  });
});

describe("putChallenge", () => {
  it("writes the row with expiry, TTL one hour later and a not-exists condition", async () => {
    const result = await store.putChallenge({ challenge: CHALLENGE, purpose: "assert", now: NOW, ttlSeconds: 300 });
    expect(result).toEqual({ created: true, expiresAt: new Date((NOW_SECONDS + 300) * 1000) });
    expect(table.calls[0]).toEqual({
      command: "PutItemCommand",
      input: {
        TableName: "AppAttest",
        Item: {
          pk: { S: `CH#${CHALLENGE}` },
          sk: { S: "CH" },
          purpose: { S: "assert" },
          createdAt: { S: NOW.toISOString() },
          expiresAt: { N: String(NOW_SECONDS + 300) },
          ttl: { N: String(NOW_SECONDS + 300 + 3600) },
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    });
  });

  it("reports a collision without throwing", async () => {
    await store.putChallenge({ challenge: CHALLENGE, purpose: "assert", now: NOW, ttlSeconds: 300 });
    expect(
      (await store.putChallenge({ challenge: CHALLENGE, purpose: "assert", now: NOW, ttlSeconds: 300 })).created,
    ).toBe(false);
  });
});

describe("consumeChallenge", () => {
  const consume = (overrides: Partial<Parameters<AppAttestStore["consumeChallenge"]>[0]> = {}) =>
    store.consumeChallenge({ challenge: CHALLENGE, purpose: "assert", consumedBy: "hash-1", now: NOW, ...overrides });

  beforeEach(() => {
    table.put(challengeRow({ challenge: CHALLENGE, purpose: "assert", expiresAt: new Date(NOW.getTime() + 60_000) }));
  });

  it("sends the exact condition and asks for ALL_OLD on failure", async () => {
    expect(await consume()).toEqual({ ok: true, replay: false });
    expect(table.calls[0].input).toEqual({
      TableName: "AppAttest",
      Key: { pk: { S: `CH#${CHALLENGE}` }, sk: { S: "CH" } },
      UpdateExpression: "SET #consumedAt = :consumedAt, #consumedBy = :consumedBy",
      ConditionExpression:
        "attribute_exists(#pk) AND #purpose = :purpose AND #expiresAt > :now AND attribute_not_exists(#consumedAt)",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#purpose": "purpose",
        "#expiresAt": "expiresAt",
        "#consumedAt": "consumedAt",
        "#consumedBy": "consumedBy",
      },
      ExpressionAttributeValues: {
        ":consumedAt": { S: NOW.toISOString() },
        ":consumedBy": { S: "hash-1" },
        ":purpose": { S: "assert" },
        ":now": { N: String(NOW_SECONDS) },
      },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
  });

  it("takes each failure reason from the old item", async () => {
    expect(await consume({ challenge: challengeOf("unknown") })).toEqual({ ok: false, reason: "challenge_unknown" });
    expect(await consume({ purpose: "attest" })).toEqual({ ok: false, reason: "challenge_purpose" });
    expect(await consume({ now: new Date(NOW.getTime() + 61_000) })).toEqual({
      ok: false,
      reason: "challenge_expired",
    });
    expect(await consume()).toEqual({ ok: true, replay: false });
    expect(await consume({ consumedBy: "hash-2" })).toEqual({ ok: false, reason: "challenge_used" });
  });

  it("treats the same bytes again as a replay", async () => {
    expect(await consume()).toEqual({ ok: true, replay: false });
    expect(await consume()).toEqual({ ok: true, replay: true });
  });

  it("does not accept a replay after the challenge expired", async () => {
    expect(await consume()).toEqual({ ok: true, replay: false });
    expect(await consume({ now: new Date(NOW.getTime() + 61_000) })).toEqual({
      ok: false,
      reason: "challenge_expired",
    });
  });

  it("rethrows other errors and passes the abort signal", async () => {
    table.failNext("UpdateItemCommand");
    await expect(consume()).rejects.toMatchObject({ name: "ThrottlingException" });
    const sends = jest.spyOn(table, "send");
    const controller = new AbortController();
    await store.consumeChallenge(
      { challenge: CHALLENGE, purpose: "assert", consumedBy: "hash-1", now: NOW },
      { signal: controller.signal },
    );
    expect(sends.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
  });
});

describe("keys: get, put, counter", () => {
  const spki = Buffer.from("spki-bytes");

  it("putKey writes every field and reports an existing key without changing it", async () => {
    expect(
      await store.putKey(
        {
          keyId: KEY_ID,
          publicKeySpki: spki,
          environment: "production",
          receipt: Buffer.from("r"),
          validationCategory: 4,
          bundleVersion: "1.2",
        },
        NOW,
      ),
    ).toBe("created");
    expect(table.calls[0].input).toMatchObject({
      ConditionExpression: "attribute_not_exists(#pk)",
      Item: {
        pk: { S: `KEY#${KEY_ID}` },
        sk: { S: "META" },
        publicKeySpki: { B: spki },
        signCount: { N: "0" },
        environment: { S: "production" },
        validationCategory: { N: "4" },
        bundleVersion: { S: "1.2" },
        receipt: { B: Buffer.from("r") },
        attestedAt: { S: NOW.toISOString() },
        lastUsedAt: { S: NOW.toISOString() },
        status: { S: "active" },
        accountCount: { N: "0" },
        signupCount: { N: "0" },
        ttl: { N: String(NOW_SECONDS + APP_ATTEST_KEY_TTL_SECONDS) },
      },
    });
    expect(
      await store.putKey(
        { keyId: KEY_ID, publicKeySpki: Buffer.from("other"), environment: "development", receipt: Buffer.from("r") },
        NOW,
      ),
    ).toBe("exists");
    expect(table.get(keyItemKey(KEY_ID))?.publicKeySpki).toEqual({ B: spki });
  });

  it("getKey reads consistently and maps the item", async () => {
    expect(await store.getKey(KEY_ID)).toBeNull();
    table.put(
      keyRow({
        keyId: KEY_ID,
        publicKeySpki: spki,
        signCount: 7,
        environment: "development",
        accountCount: 2,
        signupCount: 1,
      }),
    );
    expect(await store.getKey(KEY_ID)).toEqual({
      keyId: KEY_ID,
      publicKeySpki: spki,
      signCount: 7,
      environment: "development",
      status: "active",
      accountCount: 2,
      signupCount: 1,
    });
    expect(table.calls.at(-1)?.input).toEqual({
      TableName: "AppAttest",
      Key: keyItemKey(KEY_ID),
      ConsistentRead: true,
    });
  });

  it("advanceCounter moves only forward and only for an active key", async () => {
    table.put(keyRow({ keyId: KEY_ID, publicKeySpki: spki, signCount: 3 }));
    expect(await store.advanceCounter({ keyId: KEY_ID, counter: 3, now: NOW })).toBe(false);
    expect(await store.advanceCounter({ keyId: KEY_ID, counter: 2, now: NOW })).toBe(false);
    expect(await store.advanceCounter({ keyId: KEY_ID, counter: 4, now: NOW })).toBe(true);
    expect(table.get(keyItemKey(KEY_ID))).toMatchObject({
      signCount: { N: "4" },
      lastUsedAt: { S: NOW.toISOString() },
      ttl: { N: String(NOW_SECONDS + APP_ATTEST_KEY_TTL_SECONDS) },
    });
    expect(table.calls.at(-1)?.input).toMatchObject({
      ConditionExpression: "#signCount < :counter AND #status = :active",
      UpdateExpression: "SET #signCount = :counter, #lastUsedAt = :now, #ttl = :ttl",
    });
    table.put(keyRow({ keyId: KEY_ID, publicKeySpki: spki, signCount: 4, status: "revoked" }));
    expect(await store.advanceCounter({ keyId: KEY_ID, counter: 5, now: NOW })).toBe(false);
  });
});

describe("bindings and account count", () => {
  beforeEach(() => table.put(keyRow({ keyId: KEY_ID, publicKeySpki: Buffer.from("s"), accountCount: 1 })));

  it("binds and counts in one transaction, once per account, and refreshes the binding", async () => {
    expect(await store.getBinding("sub-1", KEY_ID)).toBeNull();
    expect(await store.bindAccount({ userId: "sub-1", keyId: KEY_ID, now: NOW })).toBe("bound");
    expect(await store.bindAccount({ userId: "sub-1", keyId: KEY_ID, now: NOW })).toBe("already_bound");
    expect(table.get(keyItemKey(KEY_ID))?.accountCount).toEqual({ N: "2" });
    expect(table.commandNames()).toEqual(["GetItemCommand", "TransactWriteItemsCommand", "TransactWriteItemsCommand"]);
    expect(table.calls[1].input.TransactItems).toEqual([
      {
        Put: expect.objectContaining({
          TableName: "AppAttest",
          Item: expect.objectContaining(bindingItemKey("sub-1", KEY_ID)),
          ConditionExpression: "attribute_not_exists(#pk)",
        }),
      },
      {
        Update: expect.objectContaining({
          TableName: "AppAttest",
          Key: keyItemKey(KEY_ID),
          UpdateExpression: "ADD #accountCount :one",
          ConditionExpression: "attribute_exists(#pk)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      },
    ]);
    expect(await store.getBinding("sub-1", KEY_ID)).toEqual({
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
    });
    const later = new Date(NOW.getTime() + 2 * 86400_000);
    await store.refreshBinding({ userId: "sub-1", keyId: KEY_ID, now: later });
    expect(table.get(bindingItemKey("sub-1", KEY_ID))).toMatchObject({
      firstSeenAt: { S: NOW.toISOString() },
      lastSeenAt: { S: later.toISOString() },
      ttl: { N: String(Math.floor(later.getTime() / 1000) + APP_ATTEST_BINDING_TTL_SECONDS) },
    });
  });

  it("with a limit (enforce) binds only while accountCount is below it, and writes nothing at it", async () => {
    expect(await store.bindAccount({ userId: "sub-2", keyId: KEY_ID, now: NOW, limit: 2 })).toBe("bound");
    expect(table.calls.at(-1)?.input.TransactItems?.[1].Update).toMatchObject({
      ConditionExpression: "attribute_exists(#pk) AND (attribute_not_exists(#accountCount) OR #accountCount < :limit)",
      ExpressionAttributeValues: { ":one": { N: "1" }, ":limit": { N: "2" } },
    });
    expect(await store.bindAccount({ userId: "sub-3", keyId: KEY_ID, now: NOW, limit: 2 })).toBe("limit");
    expect(table.get(bindingItemKey("sub-3", KEY_ID))).toBeUndefined();
    expect(table.get(keyItemKey(KEY_ID))?.accountCount).toEqual({ N: "2" });
    // An account already bound is "already_bound", not "limit", even at the limit.
    expect(await store.bindAccount({ userId: "sub-2", keyId: KEY_ID, now: NOW, limit: 2 })).toBe("already_bound");
  });

  it("a key that is gone throws rather than binding, with or without a limit", async () => {
    for (const limit of [undefined, 3]) {
      await expect(
        store.bindAccount({ userId: "sub-9", keyId: "gone", now: NOW, ...(limit ? { limit } : {}) }),
      ).rejects.toMatchObject({ name: "TransactionCanceledException" });
    }
    expect(table.get(bindingItemKey("sub-9", "gone"))).toBeUndefined();
    expect(table.get(keyItemKey("gone"))).toBeUndefined();
  });

  it("retries a transaction conflict twice, then throws; other errors throw at once", async () => {
    const conflict = () =>
      Object.assign(new Error("Transaction cancelled [None, TransactionConflict]"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
      });
    table.failNext("TransactWriteItemsCommand", conflict());
    expect(await store.bindAccount({ userId: "sub-4", keyId: KEY_ID, now: NOW })).toBe("bound");
    expect(table.commandNames()).toEqual(["TransactWriteItemsCommand", "TransactWriteItemsCommand"]);
    for (let i = 0; i < 3; i += 1) table.failNext("TransactWriteItemsCommand", conflict());
    await expect(store.bindAccount({ userId: "sub-5", keyId: KEY_ID, now: NOW })).rejects.toMatchObject({
      name: "TransactionCanceledException",
    });
    table.failNext("TransactWriteItemsCommand");
    await expect(store.bindAccount({ userId: "sub-5", keyId: KEY_ID, now: NOW })).rejects.toMatchObject({
      name: "ThrottlingException",
    });
    expect(table.get(bindingItemKey("sub-5", KEY_ID))).toBeUndefined();
    expect(table.get(keyItemKey(KEY_ID))?.accountCount).toEqual({ N: "2" });
  });

  it("refreshing a binding that expired meanwhile is a no-op, other errors throw", async () => {
    await expect(store.refreshBinding({ userId: "gone", keyId: KEY_ID, now: NOW })).resolves.toBeUndefined();
    expect(table.get(bindingItemKey("gone", KEY_ID))).toBeUndefined();
    table.failNext("UpdateItemCommand");
    await expect(store.refreshBinding({ userId: "gone", keyId: KEY_ID, now: NOW })).rejects.toMatchObject({
      name: "ThrottlingException",
    });
  });
});

describe("incrementSignupCount", () => {
  beforeEach(() => table.put(keyRow({ keyId: KEY_ID, publicKeySpki: Buffer.from("s"), signupCount: 2 })));

  it("without a limit (watch) always adds", async () => {
    expect(await store.incrementSignupCount({ keyId: KEY_ID })).toEqual({ ok: true, signupCount: 3 });
    expect(await store.incrementSignupCount({ keyId: KEY_ID })).toEqual({ ok: true, signupCount: 4 });
    expect(table.calls[0].input.ConditionExpression).toBe("attribute_exists(#pk)");
  });

  it("with a limit (enforce) stops at the limit", async () => {
    expect(await store.incrementSignupCount({ keyId: KEY_ID, limit: 3 })).toEqual({ ok: true, signupCount: 3 });
    expect(await store.incrementSignupCount({ keyId: KEY_ID, limit: 3 })).toEqual({ ok: false });
    expect(table.calls[0].input).toMatchObject({
      ConditionExpression: "attribute_exists(#pk) AND (attribute_not_exists(#signupCount) OR #signupCount < :limit)",
      ExpressionAttributeValues: { ":one": { N: "1" }, ":limit": { N: "3" } },
    });
  });

  it("does not create a key row for an unknown key", async () => {
    expect(await store.incrementSignupCount({ keyId: "unknown" })).toEqual({ ok: false });
    expect(table.get(keyItemKey("unknown"))).toBeUndefined();
  });
});

describe("client configuration", () => {
  it("uses its own DynamoDB client with an 800 ms request timeout and 2 attempts", () => {
    jest.isolateModules(() => {
      const constructed: unknown[] = [];
      jest.doMock("@aws-sdk/client-dynamodb", () => {
        const actual = jest.requireActual("@aws-sdk/client-dynamodb");
        return {
          ...actual,
          DynamoDBClient: jest.fn((config: unknown) => {
            constructed.push(config);
            return { send: jest.fn() };
          }),
        };
      });
      const isolated = require("../shared/appAttest/store");
      isolated.appAttestDynamoClient();
      isolated.appAttestDynamoClient();
      expect(constructed).toEqual([
        { maxAttempts: 2, requestHandler: { requestTimeout: 800, connectionTimeout: 800 } },
      ]);
    });
  });
});
