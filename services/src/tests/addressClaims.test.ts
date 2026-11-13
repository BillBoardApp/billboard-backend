import type {
  BatchGetItemCommandInput,
  GetItemCommandInput,
  QueryCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  ADDRESS_CHANGE_WINDOW_MS,
  ADDRESS_CLAIM_PII_ATTRIBUTES,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  addressChangeLogFromPii,
  addressClaimExists,
  addressClaimKeys,
  appendAddressChange,
  heldAddressClaimFromPii,
  listUnitClaimants,
  nextAddressChangeAllowedAt,
  normalizeMatchedAddress,
  normalizeUnit,
  parseRestampMessage,
  readClaimCounters,
  recentAddressChangeTimes,
  releaseAddressClaim,
  releaseStaleUnitClaims,
  restampMessageBody,
  sameVerificationStamp,
  sendTransaction,
  streetClaimKey,
  stripUnitSuffix,
  unitClaimKey,
  unitFromAddressLines,
  userClaimMember,
  verificationLimitsMode,
  verificationStampFromPii,
} from "../shared/addressClaims";
import * as abuseLimits from "../shared/abuseLimits";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";

type Row = Record<string, AttributeValue>;

/** One write of a transaction: the fields addressClaims puts on a Put, Delete or Update. */
interface TransactOp extends ConditionInput {
  Key?: Row;
  Item?: Row;
  UpdateExpression?: string;
}

interface FakeCommand {
  constructor: { name: string };
  input: Partial<TransactWriteItemsCommandInput & GetItemCommandInput & QueryCommandInput & BatchGetItemCommandInput>;
}

const TABLE = "VerifiedAddressClaims";
const DAY_MS = 24 * 60 * 60 * 1000;

const cancelled = (codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

/**
 * A claims table in memory: honours the exact conditions sent (fixtures/dynamoCondition) and the
 * counter forms addressClaims writes, and cancels a transaction with per-item reasons.
 */
const createClaimsTable = () => {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  const id = (key: Row) => `${key.claimKey.S}|${key.member.S}`;
  const counter = (claimKey: string, n: number) => rows.set(`${claimKey}|#COUNT`, counterRow(claimKey, n));
  const counterRow = (claimKey: string, n: number): Row => ({
    claimKey: { S: claimKey },
    member: { S: "#COUNT" },
    n: { N: String(n) },
  });
  const claim = (unitKey: string, userId: string) =>
    rows.set(`U#${unitKey}|USER#${userId}`, {
      claimKey: { S: `U#${unitKey}` },
      member: { S: `USER#${userId}` },
      claimedAt: { S: "2026-10-01T00:00:00.000Z" },
    });
  const count = (claimKey: string) => Number(rows.get(`${claimKey}|#COUNT`)?.n?.N ?? 0);

  const applyCounterUpdate = (current: Row | undefined, op: TransactOp): Row => {
    const values = op.ExpressionAttributeValues!;
    const n = Number(current?.n?.N ?? values[":zero"]?.N ?? 0);
    if (op.UpdateExpression === "SET #n = #n - :one") return { ...op.Key, n: { N: String(n - 1) } };
    if (op.UpdateExpression === "SET #n = if_not_exists(#n, :zero) + :one") {
      return { ...op.Key, n: { N: String(n + 1) } };
    }
    throw new Error(`Unexpected update ${op.UpdateExpression}`);
  };

  const send = jest.fn(async (command: FakeCommand) => {
    const name = command.constructor.name;
    calls.push(name);
    const input = command.input;
    if (name === "TransactWriteItemsCommand") {
      const entries = input.TransactItems!.map((entry) => {
        const [kind, op] = Object.entries(entry)[0] as [string, TransactOp];
        return { kind, op, key: kind === "Put" ? { claimKey: op.Item!.claimKey, member: op.Item!.member } : op.Key! };
      });
      const reasons = entries.map((entry) =>
        evaluateCondition(rows.get(id(entry.key)), entry.op) ? { Code: "None" } : { Code: "ConditionalCheckFailed" },
      );
      if (reasons.some((reason) => reason.Code !== "None")) {
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: reasons,
        });
      }
      for (const entry of entries) {
        if (entry.kind === "Delete") rows.delete(id(entry.key));
        else if (entry.kind === "Update")
          rows.set(id(entry.key), applyCounterUpdate(rows.get(id(entry.key)), entry.op));
        else rows.set(id(entry.key), entry.op.Item!);
      }
      return {};
    }
    if (name === "GetItemCommand") return { Item: rows.get(id(input.Key!)) };
    if (name === "QueryCommand") {
      const claimKey = input.ExpressionAttributeValues![":k"].S;
      const prefix = input.ExpressionAttributeValues![":prefix"].S!;
      return {
        Items: [...rows.values()].filter((row) => row.claimKey.S === claimKey && row.member.S!.startsWith(prefix)),
      };
    }
    throw new Error(`Unexpected call ${name}`);
  });

  return { rows, calls, send, counter, claim, count };
};

beforeEach(() => {
  for (const method of ["log", "warn"] as const) jest.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("addressClaims keys (C2 3.3.1)", () => {
  it.each([
    ["#4b", "4B"],
    ["Apt 4B", "4B"],
    ["APT4B", "4B"],
    ["apt. 4-b", "4B"],
    ["Unit #12", "12"],
    ["Suite 100", "100"],
    ["Ste 100", "100"],
    ["Fl 3", "3"],
    ["Floor 3", "3"],
    ["Bldg C", "C"],
    ["Building C Room 5", "C5"],
    ["Rm 210", "210"],
    ["", ""],
    [undefined, ""],
    ["  #  ", ""],
  ])("normalizeUnit(%j) is %j", (raw, expected) => {
    expect(normalizeUnit(raw as string | undefined)).toBe(expected);
  });

  it("takes the unit from line 2, else from the suffix stripUnitSuffix removes from line 1", () => {
    expect(unitFromAddressLines("100 Main St", "Apt 4B")).toBe("4B");
    expect(unitFromAddressLines("100 Main St Apt 4B", "")).toBe("4B");
    expect(unitFromAddressLines("100 Main St, #4b")).toBe("4B");
    expect(unitFromAddressLines("100 Main St Apt 9", "Unit 2")).toBe("2");
    expect(unitFromAddressLines("100 Main St Apt 9", "#")).toBe("9");
    expect(unitFromAddressLines("100 Main St")).toBe("");
  });

  it("stripUnitSuffix keeps the street line the geocoder candidates were built from", () => {
    expect(stripUnitSuffix("123 Main St Apt 4")).toBe("123 Main St");
    expect(stripUnitSuffix("1 Main St, Suite 200")).toBe("1 Main St");
    expect(stripUnitSuffix("  1   Main St  ")).toBe("1 Main St");
    expect(stripUnitSuffix("1 Main St")).toBe("1 Main St");
  });

  it("normalizes the matched address to upper case with single spaces", () => {
    expect(normalizeMatchedAddress("  100 main  st,\tSpringfield, il, 62701 ")).toBe(
      "100 MAIN ST, SPRINGFIELD, IL, 62701",
    );
  });

  it("hashes versioned unit and street strings with the caller's salted hash", () => {
    const hashed: string[] = [];
    const keys = addressClaimKeys("100 main st, springfield, il, 62701", "4B", (value) => {
      hashed.push(value);
      return `h(${value})`;
    });
    expect(hashed).toEqual([
      "addr-unit:v1:100 MAIN ST, SPRINGFIELD, IL, 62701|4B",
      "addr-street:v1:100 MAIN ST, SPRINGFIELD, IL, 62701",
    ]);
    expect(keys).toEqual({
      unitKey: "h(addr-unit:v1:100 MAIN ST, SPRINGFIELD, IL, 62701|4B)",
      streetKey: "h(addr-street:v1:100 MAIN ST, SPRINGFIELD, IL, 62701)",
    });
    expect(unitClaimKey("u")).toBe("U#u");
    expect(streetClaimKey("s")).toBe("S#s");
    expect(userClaimMember("sub-1")).toBe("USER#sub-1");
  });

  it("exports the limits and names other lanes rely on", () => {
    expect(MAX_VERIFIED_ACCOUNTS_PER_ADDRESS).toBe(abuseLimits.MAX_VERIFIED_ACCOUNTS_PER_ADDRESS);
    expect(MAX_ADDRESS_CHANGES_PER_WINDOW).toBe(abuseLimits.MAX_ADDRESS_CHANGES_PER_WINDOW);
    expect(ADDRESS_CHANGE_WINDOW_MS).toBe(abuseLimits.ADDRESS_CHANGE_WINDOW_MS);
    expect(ACCOUNT_INTEGRITY_METRIC_NAMESPACE).toBe("BillBoard/AccountIntegrity");
    expect(ADDRESS_CLAIM_PII_ATTRIBUTES).toEqual(["verifiedAddressKey", "verifiedStreetKey", "addressChangeLog"]);
  });
});

describe("verificationLimitsMode", () => {
  it.each([
    ["enforce", "enforce"],
    ["watch", "watch"],
    ["ENFORCE", "watch"],
    ["", "watch"],
    [undefined, "watch"],
  ])("%j is %s", (value, expected) => {
    expect(verificationLimitsMode(value as string | undefined)).toBe(expected);
  });

  it("reads VERIFICATION_LIMITS_MODE when called without a value", () => {
    const previous = process.env.VERIFICATION_LIMITS_MODE;
    try {
      process.env.VERIFICATION_LIMITS_MODE = "enforce";
      expect(verificationLimitsMode()).toBe("enforce");
      delete process.env.VERIFICATION_LIMITS_MODE;
      expect(verificationLimitsMode()).toBe("watch");
    } finally {
      if (previous === undefined) delete process.env.VERIFICATION_LIMITS_MODE;
      else process.env.VERIFICATION_LIMITS_MODE = previous;
    }
  });
});

describe("address change log (MAX_ADDRESS_CHANGES_PER_WINDOW changes in ADDRESS_CHANGE_WINDOW_MS)", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const WINDOW_DAYS = ADDRESS_CHANGE_WINDOW_MS / DAY_MS;
  const MAX = MAX_ADDRESS_CHANGES_PER_WINDOW;
  /** `count` changes, each `days` ago. */
  const changes = (count: number, days: number) => Array.from({ length: count }, () => daysAgo(days));

  it("reads the log from UserPII and drops unreadable entries", () => {
    expect(addressChangeLogFromPii(undefined)).toEqual([]);
    expect(
      addressChangeLogFromPii({ addressChangeLog: { L: [{ S: daysAgo(1) }, { S: "not a date" }, { N: "5" }] } }),
    ).toEqual([daysAgo(1)]);
  });

  it("counts only changes younger than the window", () => {
    expect(
      recentAddressChangeTimes(
        [daysAgo(WINDOW_DAYS + 1), daysAgo(WINDOW_DAYS), daysAgo(WINDOW_DAYS - 0.1), daysAgo(1)],
        now,
      ),
    ).toEqual([now - (WINDOW_DAYS - 0.1) * DAY_MS, now - DAY_MS]);
  });

  it("allows a change until the limit is recent, then until the oldest of them leaves the window", () => {
    expect(nextAddressChangeAllowedAt([...changes(MAX - 2, 10), daysAgo(1)], now)).toBeNull();
    expect(nextAddressChangeAllowedAt([daysAgo(1), daysAgo(WINDOW_DAYS - 10), ...changes(MAX - 2, 10)], now)).toBe(
      now + 10 * DAY_MS,
    );
    expect(
      nextAddressChangeAllowedAt([daysAgo(WINDOW_DAYS + 10), ...changes(MAX - 2, 10), daysAgo(1)], now),
    ).toBeNull();
  });

  it("appends a change, oldest first, keeping the newest MAX_ADDRESS_CHANGES_PER_WINDOW", () => {
    const older = Array.from({ length: MAX - 1 }, (_, index) => daysAgo(5 * (MAX - index)));
    const appended = appendAddressChange([daysAgo(5), "junk", ...older], daysAgo(0));
    expect(appended).toEqual([...older.slice(1), daysAgo(5), daysAgo(0)]);
    expect(appendAddressChange([], daysAgo(0))).toEqual([daysAgo(0)]);
  });
});

describe("UserPII claim and vote stamp", () => {
  it("reads the held claim", () => {
    expect(heldAddressClaimFromPii(undefined)).toBeNull();
    expect(heldAddressClaimFromPii({ verifiedStreetKey: { S: "s" } })).toBeNull();
    expect(heldAddressClaimFromPii({ verifiedAddressKey: { S: "u" } })).toEqual({ unitKey: "u" });
    expect(heldAddressClaimFromPii({ verifiedAddressKey: { S: "u" }, verifiedStreetKey: { S: "s" } })).toEqual({
      unitKey: "u",
      streetKey: "s",
    });
  });

  it("derives the stamp exactly as SetFeedback stamps a new vote", () => {
    expect(verificationStampFromPii(undefined)).toEqual({
      constituentVerified: false,
      verificationStatus: "self_attested",
    });
    expect(
      verificationStampFromPii({
        constituentVerified: { BOOL: true },
        resolvedState: { S: "IL" },
        resolvedDistrict: { S: "IL-13" },
      }),
    ).toEqual({
      constituentVerified: true,
      verificationStatus: "likely_constituent",
      resolvedState: "IL",
      resolvedDistrict: "IL-13",
    });
    // A capped account: unverified, so no state or district even if selfAttested fields exist.
    expect(
      verificationStampFromPii({
        constituentVerified: { BOOL: false },
        verificationStatus: { S: "self_attested" },
        verificationMethod: { S: "address_capped" },
        selfAttestedState: { S: "IL" },
        resolvedState: { S: "IL" },
      }),
    ).toEqual({ constituentVerified: false, verificationStatus: "self_attested" });
  });

  it("compares stamps field by field", () => {
    const base = { constituentVerified: true, verificationStatus: "likely_constituent", resolvedState: "IL" };
    expect(sameVerificationStamp(base, { ...base })).toBe(true);
    expect(sameVerificationStamp(base, { ...base, resolvedDistrict: "IL-13" })).toBe(false);
    expect(sameVerificationStamp(base, { ...base, constituentVerified: false })).toBe(false);
    expect(sameVerificationStamp(base, { ...base, verificationStatus: "self_attested" })).toBe(false);
    expect(sameVerificationStamp(base, { ...base, resolvedState: "WI" })).toBe(false);
  });
});

describe("re-stamp message", () => {
  it("round-trips the user ID", () => {
    expect(restampMessageBody("sub-1")).toBe('{"userId":"sub-1"}');
    expect(parseRestampMessage(restampMessageBody("sub-1"))).toBe("sub-1");
    expect(parseRestampMessage('{"userId":"  sub-2  "}')).toBe("sub-2");
  });

  it.each([null, undefined, "", "not json", "null", "[]", '{"userId":""}', '{"userId":5}', '{"user":"x"}'])(
    "rejects %j",
    (body) => {
      expect(parseRestampMessage(body as string | null | undefined)).toBeNull();
    },
  );
});

describe("sendTransaction", () => {
  const parts = [
    { role: "a" as const, item: { ConditionCheck: { TableName: TABLE, Key: {}, ConditionExpression: "x" } } },
    { role: "b" as const, item: { ConditionCheck: { TableName: TABLE, Key: {}, ConditionExpression: "y" } } },
  ];

  it("sends the parts as one TransactWriteItems call", async () => {
    const send = jest.fn().mockResolvedValue({});
    await expect(sendTransaction({ send }, parts)).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(TransactWriteItemsCommand);
    expect(send.mock.calls[0][0].input.TransactItems).toEqual(parts.map((part) => part.item));
  });

  it("names the parts whose condition failed", async () => {
    const send = jest.fn().mockRejectedValue(cancelled(["None", "ConditionalCheckFailed"]));
    const result = await sendTransaction({ send }, parts);
    expect(result).toEqual({ ok: false, failed: new Set(["b"]) });
  });

  it("retries a conflict twice, then succeeds or throws", async () => {
    const conflict = cancelled(["TransactionConflict", "None"]);
    const send = jest.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({});
    await expect(sendTransaction({ send }, parts)).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);

    const always = jest.fn().mockRejectedValue(conflict);
    await expect(sendTransaction({ send: always }, parts)).rejects.toBe(conflict);
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("throws any other error, and a cancellation that is neither a condition nor transient", async () => {
    const other = new Error("boom");
    await expect(sendTransaction({ send: jest.fn().mockRejectedValue(other) }, parts)).rejects.toBe(other);
    const validation = cancelled(["ValidationError", "None"]);
    const send = jest.fn().mockRejectedValue(validation);
    await expect(sendTransaction({ send }, parts)).rejects.toBe(validation);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("releaseAddressClaim (X5 a)", () => {
  const claim = { unitKey: "unit", streetKey: "street" };

  it("deletes the claim and decrements both counters in one transaction", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");
    table.claim("unit", "u2");
    table.counter("U#unit", 2);
    table.counter("S#street", 3);

    await expect(releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).resolves.toBe("released");

    expect(table.calls).toEqual(["TransactWriteItemsCommand"]);
    expect(table.rows.has("U#unit|USER#u1")).toBe(false);
    expect(table.rows.has("U#unit|USER#u2")).toBe(true);
    expect(table.count("U#unit")).toBe(1);
    expect(table.count("S#street")).toBe(2);
    const items = table.send.mock.calls[0][0].input.TransactItems;
    expect(items).toEqual([
      {
        Delete: expect.objectContaining({
          TableName: TABLE,
          Key: { claimKey: { S: "U#unit" }, member: { S: "USER#u1" } },
          ConditionExpression: "attribute_exists(#m)",
        }),
      },
      { Update: expect.objectContaining({ ConditionExpression: "#n > :zero" }) },
      { Update: expect.objectContaining({ ConditionExpression: "#n > :zero" }) },
    ]);
  });

  it("is a no-op with no claim: no call when the profile records none, nothing changed when the row is gone", async () => {
    const table = createClaimsTable();
    table.counter("U#unit", 1);
    table.counter("S#street", 1);

    await expect(releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim: null })).resolves.toBe(
      "no_claim",
    );
    await expect(releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim: undefined })).resolves.toBe(
      "no_claim",
    );
    expect(table.calls).toEqual([]);

    await expect(releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).resolves.toBe("no_claim");
    expect(table.calls).toEqual(["TransactWriteItemsCommand"]);
    expect(table.count("U#unit")).toBe(1);
    expect(table.count("S#street")).toBe(1);
  });

  it("a retried release (deletion rerun) changes nothing the second time", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");
    table.counter("U#unit", 1);
    table.counter("S#street", 1);

    expect(await releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).toBe("released");
    expect(await releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).toBe("no_claim");
    expect([table.count("U#unit"), table.count("S#street")]).toEqual([0, 0]);
  });

  it("releases the claim without a counter already at 0 (drift) and never goes negative", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");
    table.counter("U#unit", 0);
    table.counter("S#street", 1);

    expect(await releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).toBe("released");
    expect(table.rows.has("U#unit|USER#u1")).toBe(false);
    expect([table.count("U#unit"), table.count("S#street")]).toEqual([0, 0]);
    expect(table.calls).toEqual(["TransactWriteItemsCommand", "TransactWriteItemsCommand"]);
  });

  it("leaves the street counter alone when the profile has no street key", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");
    table.counter("U#unit", 1);
    table.counter("S#street", 5);

    expect(await releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim: { unitKey: "unit" } })).toBe(
      "released",
    );
    expect(table.send.mock.calls[0][0].input.TransactItems).toHaveLength(2);
    expect(table.count("S#street")).toBe(5);
  });

  it("throws other errors", async () => {
    const error = new Error("throttled");
    await expect(
      releaseAddressClaim({ db: { send: jest.fn().mockRejectedValue(error) }, tableName: TABLE, userId: "u1", claim }),
    ).rejects.toBe(error);
  });

  it("with both counters already at 0 still deletes the claim, in three attempts", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");
    table.counter("U#unit", 0);
    table.counter("S#street", 0);

    expect(await releaseAddressClaim({ db: table, tableName: TABLE, userId: "u1", claim })).toBe("released");
    expect(table.rows.has("U#unit|USER#u1")).toBe(false);
    expect([table.count("U#unit"), table.count("S#street")]).toEqual([0, 0]);
    expect(table.send.mock.calls.map((call) => call[0].input.TransactItems!.length)).toEqual([3, 1]);
  });
});

describe("addressClaimExists (X5 dry run)", () => {
  it("reads the claim row the profile points at", async () => {
    const table = createClaimsTable();
    table.claim("unit", "u1");

    expect(await addressClaimExists({ db: table, tableName: TABLE, userId: "u1", claim: { unitKey: "unit" } })).toBe(
      true,
    );
    expect(await addressClaimExists({ db: table, tableName: TABLE, userId: "u2", claim: { unitKey: "unit" } })).toBe(
      false,
    );
    expect(await addressClaimExists({ db: table, tableName: TABLE, userId: "u1", claim: null })).toBe(false);
    expect(table.calls).toEqual(["GetItemCommand", "GetItemCommand"]);
    expect(table.send.mock.calls[0][0]).toBeInstanceOf(GetItemCommand);
    expect(table.send.mock.calls[0][0].input.Key).toEqual({ claimKey: { S: "U#unit" }, member: { S: "USER#u1" } });
  });
});

describe("claim reads", () => {
  it("lists a unit's claimants across pages, skipping the counter row", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Items: [{ member: { S: "USER#u1" } }, { member: { S: "#COUNT" } }],
        LastEvaluatedKey: { claimKey: { S: "U#unit" }, member: { S: "USER#u1" } },
      })
      .mockResolvedValueOnce({ Items: [{ member: { S: "USER#u2" } }] });

    expect(await listUnitClaimants({ send }, TABLE, "unit")).toEqual(["u1", "u2"]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input).toEqual(
      expect.objectContaining({
        KeyConditionExpression: "#k = :k AND begins_with(#m, :prefix)",
        ExpressionAttributeValues: { ":k": { S: "U#unit" }, ":prefix": { S: "USER#" } },
      }),
    );
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      claimKey: { S: "U#unit" },
      member: { S: "USER#u1" },
    });
  });

  it("reads counters in one BatchGetItem, missing rows as 0", async () => {
    const send = jest.fn().mockResolvedValue({
      Responses: { [TABLE]: [{ claimKey: { S: "U#unit" }, n: { N: "4" } }] },
    });

    const counts = await readClaimCounters({ send }, TABLE, ["U#unit", "S#street"], { consistentRead: true });

    expect([...counts]).toEqual([
      ["U#unit", 4],
      ["S#street", 0],
    ]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(BatchGetItemCommand);
    expect(send.mock.calls[0][0].input.RequestItems[TABLE]).toEqual(
      expect.objectContaining({
        ConsistentRead: true,
        Keys: [
          { claimKey: { S: "U#unit" }, member: { S: "#COUNT" } },
          { claimKey: { S: "S#street" }, member: { S: "#COUNT" } },
        ],
      }),
    );
    expect(await readClaimCounters({ send }, TABLE, [])).toEqual(new Map());
  });
});

describe("releaseStaleUnitClaims (self-heal)", () => {
  const pii = { tableName: "UserPII", partitionKey: "userId" };

  /** The claims table plus a UserPII BatchGetItem answering from `profiles` (unset: no row). */
  const setup = (profiles: Record<string, Row>, options: { unprocessed?: string[] } = {}) => {
    const table = createClaimsTable();
    const batchGets: FakeCommand["input"][] = [];
    const send = jest.fn(async (command: FakeCommand) => {
      if (command.constructor.name !== "BatchGetItemCommand") return table.send(command);
      batchGets.push(command.input);
      const keys = command.input.RequestItems!.UserPII.Keys as Row[];
      const unprocessed = keys.filter((key) => options.unprocessed?.includes(key.userId.S!));
      return {
        Responses: {
          UserPII: keys
            .filter((key) => !unprocessed.includes(key) && profiles[key.userId.S!])
            .map((key) => profiles[key.userId.S!]),
        },
        UnprocessedKeys: unprocessed.length ? { UserPII: { Keys: unprocessed } } : {},
      };
    });
    return { table, send, batchGets };
  };

  it("releases claims of accounts with no profile or a deletion in progress or done, and keeps the rest", async () => {
    const { table, send, batchGets } = setup({
      live: { userId: { S: "live" } },
      failed: { userId: { S: "failed" }, deletionStatus: { S: "failed" } },
      deleting: { userId: { S: "deleting" }, deletionStatus: { S: "in_progress" } },
      deleted: { userId: { S: "deleted" }, deletionStatus: { S: "completed" } },
    });
    for (const user of ["live", "failed", "deleting", "deleted", "gone"]) table.claim("unit", user);
    table.counter("U#unit", 5);
    table.counter("S#street", 7);

    const result = await releaseStaleUnitClaims({
      db: { send },
      tableName: TABLE,
      pii,
      unitKey: "unit",
      streetKey: "street",
    });

    expect(result).toEqual({ claimants: 5, released: 3 });
    expect([...table.rows.keys()].filter((key) => key.includes("USER#")).sort()).toEqual([
      "U#unit|USER#failed",
      "U#unit|USER#live",
    ]);
    expect(table.count("U#unit")).toBe(2);
    expect(table.count("S#street")).toBe(4);
    expect(batchGets[0].RequestItems!.UserPII).toEqual(expect.objectContaining({ ConsistentRead: true }));
  });

  it("does nothing for a unit with no claimants", async () => {
    const { send, batchGets } = setup({});
    expect(
      await releaseStaleUnitClaims({ db: { send }, tableName: TABLE, pii, unitKey: "unit", streetKey: "street" }),
    ).toEqual({ claimants: 0, released: 0 });
    expect(batchGets).toEqual([]);
  });

  it("retries unprocessed keys and leaves an account it could not read alone", async () => {
    const { table, send, batchGets } = setup({}, { unprocessed: ["unread"] });
    table.claim("unit", "unread");
    table.claim("unit", "gone");
    table.counter("U#unit", 2);
    table.counter("S#street", 2);

    const result = await releaseStaleUnitClaims({
      db: { send },
      tableName: TABLE,
      pii,
      unitKey: "unit",
      streetKey: "street",
    });

    expect(result).toEqual({ claimants: 2, released: 1 });
    expect(table.rows.has("U#unit|USER#unread")).toBe(true);
    expect(batchGets).toHaveLength(4);
  });
});

describe("dynamoCondition fixture sanity", () => {
  it("evaluates the counter cap the way DynamoDB does", () => {
    const cap = {
      ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":max": { N: "4" } },
    };
    expect(evaluateCondition(undefined, cap)).toBe(true);
    expect(evaluateCondition({ n: { N: "3" } }, cap)).toBe(true);
    expect(evaluateCondition({ n: { N: "4" } }, cap)).toBe(false);
    expect(conditionalCheckFailed().name).toBe("ConditionalCheckFailedException");
  });
});
