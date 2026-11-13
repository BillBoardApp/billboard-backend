import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  CONGRESS_START,
  INTERRUPTED,
  MARKER_ATTRIBUTE,
  NEW_MAP_STATES,
  NOTICE_BODY,
  NOTICE_TITLE,
  USER_PACE_MS,
  audienceStates,
  claimMarkerInput,
  classifyUser,
  configFromEnv,
  noticeApnsPayload,
  noticeMessage,
  parseArgs,
  redact,
  runNotice,
  sendWindowRefusal,
  watchInterrupts,
  type AudienceOptions,
  type Candidate,
  type NoticeConfig,
  type NoticeDeps,
} from "../../scripts/sendDistrictNotice";
import { isInQuietHours, timeZoneForState } from "../shared/quietHours";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";

/*
 * `npm run send:district-notice` (REL-46 PR 7, RUNBOOK 24.5): the one push of the 120th Congress to users whose
 * district may have changed. UserPII and UserDevices are in memory; the marker claim honours the exact condition sent
 * (fixtures/dynamoCondition). The dry run prints counts only; --apply claims a marker before each send, in the window,
 * at the expected count; --canary writes no marker.
 */

type Item = Record<string, AttributeValue>;
interface CallInput {
  TableName?: string;
  Key?: Item;
  ExclusiveStartKey?: Item;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ConditionExpression?: string;
  UpdateExpression?: string;
  TargetArn?: string;
  Message?: string;
  MessageStructure?: string;
}
interface FakeCommand {
  constructor: { name: string };
  input: CallInput;
}
type Event = { type: "scan" | "query" | "claim" | "clear" | "publish"; table?: string; userId?: string; arn?: string };

const PII = "UserPII";
const DEVICES = "UserDevices";
const config: NoticeConfig = { region: "us-east-1", piiTableName: PII, deviceTableName: DEVICES, canarySub: "" };
const SEND_TIME = Date.parse("2027-01-04T17:00:00.000Z");

const arnOf = (userId: string, device: string) =>
  `arn:aws:sns:us-east-1:123456789012:endpoint/APNS/BillboardApp/${userId}-${device}`;

const verified = (userId: string, state: string, extra: Item = {}): Item => ({
  userId: { S: userId },
  verificationMethod: { S: "address_geocode" },
  constituentVerified: { BOOL: true },
  verificationStatus: { S: "likely_constituent" },
  verifiedAt: { S: "2026-06-01T12:00:00.000Z" },
  resolvedState: { S: state },
  resolvedDistrict: { S: `${state}-12` },
  ...extra,
});

const selfAttested = (userId: string, state: string): Item => ({
  userId: { S: userId },
  verificationMethod: { S: "manual_state_district" },
  constituentVerified: { BOOL: false },
  verificationStatus: { S: "self_attested" },
  verifiedAt: { S: "2026-06-01T12:00:00.000Z" },
  selfAttestedState: { S: state },
  selfAttestedDistrict: { S: `${state}-03` },
});

/** A manual pick from before 2026-03-23: the state and district in resolvedState and resolvedDistrict. */
const legacySelfAttested = (userId: string, state: string): Item => ({
  userId: { S: userId },
  verificationMethod: { S: "manual_state_district" },
  constituentVerified: { BOOL: false },
  verificationStatus: { S: "self_attested" },
  verifiedAt: { S: "2026-02-10T12:00:00.000Z" },
  resolvedState: { S: state },
  resolvedDistrict: { S: `${state}-07` },
  claimedDistrict: { S: `${state}-07` },
});

/** Geocoded past the address limit (districtVerification's cappedPiiUpdate): the geocoder's state and district. */
const capped = (userId: string, state: string, extra: Item = {}): Item => ({
  userId: { S: userId },
  verificationMethod: { S: "address_capped" },
  constituentVerified: { BOOL: false },
  verificationStatus: { S: "self_attested" },
  verificationLimitReason: { S: "address_limit" },
  verifiedAt: { S: "2026-06-01T12:00:00.000Z" },
  selfAttestedState: { S: state },
  selfAttestedDistrict: { S: `${state}-05` },
  ...extra,
});

const device = (userId: string, name: string, extra: Item = {}): Item => ({
  userId: { S: userId },
  deviceId: { S: `device-${userId}-${name}` },
  endpointArn: { S: arnOf(userId, name) },
  notificationsEnabled: { BOOL: true },
  ...extra,
});

/** Sendable: ca-1, fl-1, la-1, mo-1, oh-1 (one device each). */
const fixtureUsers = (): Item[] => [
  verified("user-ca-1", "CA"),
  verified("user-ca-2", "CA"),
  verified("user-tx-1", "TX"),
  verified("user-tx-2", "TX", { [MARKER_ATTRIBUTE]: { S: "2027-01-04T16:10:00.000Z" } }),
  verified("user-fl-1", "FL"),
  verified("user-la-1", "LA", { deletionStatus: { S: "failed" } }),
  verified("user-al-1", "AL", { deletionStatus: { S: "in_progress" } }),
  verified("user-mo-1", "MO", { verifiedAt: { S: "2026-05-10T09:00:00.000Z" } }),
  verified("user-mo-2", "MO", { verifiedAt: { S: "2026-03-01T09:00:00.000Z" } }),
  verified("user-ny-1", "NY"),
  selfAttested("user-oh-1", "OH"),
  capped("user-ut-1", "UT"),
  selfAttested("user-ny-2", "NY"),
];

const fixtureDevices = (): Map<string, Item[]> =>
  new Map([
    ["user-ca-1", [device("user-ca-1", "a")]],
    ["user-tx-1", [device("user-tx-1", "a", { notificationsEnabled: { BOOL: false } })]],
    ["user-tx-2", [device("user-tx-2", "a")]],
    [
      "user-fl-1",
      [
        device("user-fl-1", "a"),
        // Not an SNS endpoint: never a target.
        device("user-fl-1", "b", { endpointArn: { S: "arn:aws:sns:us-east-1:123456789012:BillboardTopic" } }),
      ],
    ],
    ["user-la-1", [device("user-la-1", "a")]],
    ["user-al-1", [device("user-al-1", "a")]],
    ["user-mo-1", [device("user-mo-1", "a")]],
    ["user-oh-1", [device("user-oh-1", "a")]],
    [
      "canary-sub-0001",
      [device("canary-sub-0001", "a"), device("canary-sub-0001", "b", { notificationsEnabled: { BOOL: false } })],
    ],
  ]);

let pii: Map<string, Item>;
let devices: Map<string, Item[]>;
let events: Event[];
let scans: CallInput[];
let publishes: CallInput[];
let publishErrors: Map<string, Error>;
let beforeUpdate: ((userId: string) => void) | undefined;
let lines: string[];
let clock: number;
let sleeps: number[];
let dir: string;

const dynamoSend = jest.fn(async (command: FakeCommand): Promise<unknown> => {
  const name = command.constructor.name;
  const input = command.input;
  if (name === "ScanCommand") {
    events.push({ type: "scan", table: input.TableName });
    scans.push(input);
    if (input.TableName !== PII) throw new Error(`Scan of ${input.TableName}`);
    // Two pages, as a real Scan of a larger table would give.
    const all = [...pii.values()];
    const half = Math.ceil(all.length / 2);
    return input.ExclusiveStartKey
      ? { Items: all.slice(half) }
      : { Items: all.slice(0, half), LastEvaluatedKey: { userId: all[half - 1].userId } };
  }
  if (name === "QueryCommand") {
    events.push({ type: "query", table: input.TableName });
    if (input.TableName !== DEVICES) throw new Error(`Query of ${input.TableName}`);
    const userId = input.ExpressionAttributeValues?.[":userValue"]?.S ?? "";
    return { Items: devices.get(userId) ?? [] };
  }
  if (name === "UpdateItemCommand") {
    if (input.TableName !== PII) throw new Error(`Write to ${input.TableName}`);
    const userId = input.Key?.userId?.S ?? "";
    beforeUpdate?.(userId);
    const item = pii.get(userId);
    if (!evaluateCondition(item, input)) throw conditionalCheckFailed();
    if (!item) throw new Error("A passing condition on a missing item");
    if (input.UpdateExpression === "SET #marker = :now") {
      pii.set(userId, { ...item, [MARKER_ATTRIBUTE]: input.ExpressionAttributeValues![":now"] });
      events.push({ type: "claim", table: input.TableName, userId });
    } else if (input.UpdateExpression === "REMOVE #marker") {
      const { [MARKER_ATTRIBUTE]: _removed, ...rest } = item;
      pii.set(userId, rest);
      events.push({ type: "clear", table: input.TableName, userId });
    } else throw new Error(`Unexpected update ${input.UpdateExpression}`);
    return {};
  }
  throw new Error(`Unexpected DynamoDB command ${name}`);
});
const dynamo = { send: dynamoSend } as unknown as DynamoDBClient;

const sns = {
  send: jest.fn(async (command: FakeCommand): Promise<unknown> => {
    if (command.constructor.name !== "PublishCommand") throw new Error(`Unexpected SNS command`);
    const error = publishErrors.get(command.input.TargetArn ?? "");
    if (error) throw error;
    publishes.push(command.input);
    events.push({ type: "publish", arn: command.input.TargetArn });
    return { MessageId: "m" };
  }),
};

beforeEach(() => {
  pii = new Map(fixtureUsers().map((item) => [item.userId.S!, item]));
  devices = fixtureDevices();
  events = [];
  scans = [];
  publishes = [];
  publishErrors = new Map();
  beforeUpdate = undefined;
  lines = [];
  clock = SEND_TIME;
  sleeps = [];
  dir = mkdtempSync(join(tmpdir(), "district-notice-"));
  dynamoSend.mockClear();
  sns.send.mockClear();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (argv: string[], overrides: Partial<NoticeConfig> = {}, extra: Pick<NoticeDeps, "interrupted"> = {}) =>
  runNotice({
    ...extra,
    dynamo,
    sns,
    config: { ...config, ...overrides },
    options: parseArgs(argv),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (line) => lines.push(line),
  });

const summaryPath = () => join(dir, "summary.json");
const applyArgs = (expected: number) => [
  "--apply",
  "--expect-sendable",
  String(expected),
  "--summary-file",
  summaryPath(),
];

/** Every id, ARN and district the fixtures hold. */
const fixtureSecrets = (): string[] => {
  const values = new Set<string>();
  for (const item of [...pii.values(), ...[...devices.values()].flat()]) {
    for (const key of [
      "userId",
      "deviceId",
      "endpointArn",
      "resolvedDistrict",
      "selfAttestedDistrict",
      "claimedDistrict",
    ]) {
      const value = item[key]?.S;
      if (value) values.add(value);
    }
  }
  values.add("canary-sub-0001");
  return [...values];
};

const expectNoSecrets = (text: string) => {
  for (const secret of fixtureSecrets()) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/arn:aws/);
  expect(text).not.toContain("endpoint/");
};

const cellOf = (result: Awaited<ReturnType<typeof run>>, group: string, state: string) =>
  result.plan?.cells.find((cell) => cell.group === group && cell.state === state);

const writes = () =>
  events.filter((event) => event.type === "claim" || event.type === "clear" || event.type === "publish");

describe("parseArgs", () => {
  test("defaults to a dry run with the plan's audience (D9 recommendation)", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      mode: "dry-run",
      expectSendable: null,
      expectMarkers: null,
      summaryFile: null,
      audience: { missouriSince: "2026-04-01T00:00:00.000Z", selfAttested: true },
    });
  });

  test("switches each audience group", () => {
    expect(parseArgs(["--no-missouri"]).audience.missouriSince).toBeNull();
    expect(parseArgs(["--missouri-since", "2026-05-15"]).audience.missouriSince).toBe("2026-05-15T00:00:00.000Z");
    expect(parseArgs(["--no-self-attested"]).audience.selfAttested).toBe(false);
  });

  test("names each mode", () => {
    expect(parseArgs(["--canary"]).mode).toBe("canary");
    expect(parseArgs(applyArgs(3)).mode).toBe("apply");
    expect(parseArgs(["--clear-markers"]).mode).toBe("markers");
    expect(parseArgs(["--clear-markers", "--apply", "--expect-markers", "2", "--summary-file", "s.json"]).mode).toBe(
      "clear-markers",
    );
  });

  test.each([
    [["--dry-run"], /Unknown argument/],
    [["--apply"], /--expect-sendable/],
    [["--apply", "--expect-sendable", "3"], /--summary-file/],
    [["--apply", "--expect-sendable", "three", "--summary-file", "s.json"], /whole number/],
    [["--expect-sendable", "3"], /goes with --apply only/],
    [["--canary", "--apply"], /--canary runs alone/],
    [["--canary", "--summary-file", "s.json"], /writes no summary/],
    [["--canary", "--no-missouri"], /audience flags/],
    [["--clear-markers", "--no-self-attested"], /audience flags/],
    [["--clear-markers", "--apply", "--summary-file", "s.json"], /--expect-markers/],
    [["--expect-markers", "2"], /--clear-markers --apply only/],
    [["--no-missouri", "--missouri-since", "2026-04-01"], /contradict/],
    [["--missouri-since", "April"], /YYYY-MM-DD/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  test("reads the environment, with production's table names by default", () => {
    expect(configFromEnv({})).toEqual(config);
    expect(configFromEnv({ NOTICE_CANARY_SUB: " sub \n", PII_TABLE_NAME: "P" })).toMatchObject({
      canarySub: "sub",
      piiTableName: "P",
    });
  });
});

describe("the dry run", () => {
  test("counts per group and state", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(cellOf(result, "verified", "CA")).toMatchObject({ candidates: 2, sendable: 1, noDevice: 1 });
    expect(cellOf(result, "verified", "TX")).toMatchObject({ candidates: 2, alreadySent: 1, notificationsOff: 1 });
    expect(cellOf(result, "verified", "FL")).toMatchObject({ candidates: 1, sendable: 1 });
    // deletionStatus failed is an active account; in_progress is being deleted.
    expect(cellOf(result, "verified", "LA")).toMatchObject({ candidates: 1, sendable: 1 });
    expect(cellOf(result, "verified", "AL")).toMatchObject({ candidates: 0 });
    // Only the Missouri user verified since the cutoff.
    expect(cellOf(result, "missouri", "MO")).toMatchObject({ candidates: 1, sendable: 1 });
    expect(cellOf(result, "selfAttested", "OH")).toMatchObject({ candidates: 1, sendable: 1 });
    // A capped user's district is the geocoder's: the verified group, not the self-attested one.
    expect(cellOf(result, "verified", "UT")).toMatchObject({ candidates: 1, noDevice: 1 });
    expect(cellOf(result, "selfAttested", "UT")).toMatchObject({ candidates: 0 });
    expect(result.plan?.cells).toHaveLength(NEW_MAP_STATES.length * 2 + 1);
    expect(result.plan?.totals).toEqual({
      candidates: 9,
      alreadySent: 1,
      sendable: 5,
      noDevice: 2,
      notificationsOff: 1,
      markers: 1,
    });
    expect(lines).toContain(
      "District notice plan: candidates=9 alreadySent=1 sendable=5 noDevice=2 notificationsOff=1 markers=1",
    );
    expect(lines).toContain(`Wording: "${NOTICE_TITLE}" / "${NOTICE_BODY}"`);
  });

  test("prints no fixture id, ARN or district, and writes nothing", async () => {
    await run(["--summary-file", summaryPath()]);
    expectNoSecrets(lines.join("\n"));
    expectNoSecrets(readFileSync(summaryPath(), "utf8"));
    expect(writes()).toEqual([]);
    expect(sns.send).not.toHaveBeenCalled();
  });

  test("reads no district or address from UserPII", async () => {
    await run([]);
    expect(scans).toHaveLength(2);
    const read = Object.values(scans[0].ExpressionAttributeNames ?? {});
    expect(read).not.toEqual(expect.arrayContaining([expect.stringMatching(/District|Address|address|Street/)]));
    expect(read).toEqual(expect.arrayContaining(["resolvedState", "selfAttestedState", MARKER_ATTRIBUTE]));
  });

  test("leaves out the Missouri and self-attested groups when switched off", async () => {
    const withoutMissouri = await run(["--no-missouri"]);
    expect(cellOf(withoutMissouri, "missouri", "MO")).toBeUndefined();
    expect(withoutMissouri.plan?.totals.sendable).toBe(4);
    const withoutSelfAttested = await run(["--no-self-attested"]);
    expect(withoutSelfAttested.plan?.cells.some((cell) => cell.group === "selfAttested")).toBe(false);
    expect(withoutSelfAttested.plan?.totals.sendable).toBe(4);
    expect(cellOf(withoutSelfAttested, "verified", "UT")).toMatchObject({ candidates: 1 });
    const laterCutoff = await run(["--missouri-since", "2026-06-01"]);
    expect(cellOf(laterCutoff, "missouri", "MO")).toMatchObject({ candidates: 0 });
  });

  test("puts capped users with the geocoded groups, and reads a legacy self-attested row's resolvedState", async () => {
    const add = (item: Item, withDevice = true) => {
      pii.set(item.userId.S!, item);
      if (withDevice) devices.set(item.userId.S!, [device(item.userId.S!, "a")]);
    };
    add(capped("user-ca-3", "CA"));
    add(capped("user-mo-3", "MO", { verifiedAt: { S: "2026-07-01T09:00:00.000Z" } }));
    add(capped("user-mo-4", "MO", { verifiedAt: { S: "2026-03-01T09:00:00.000Z" } }));
    add(legacySelfAttested("user-tx-3", "TX"));
    add(legacySelfAttested("user-ny-3", "NY"));

    const result = await run([]);
    expect(cellOf(result, "verified", "CA")).toMatchObject({ candidates: 3, sendable: 2 });
    // The capped Missouri user verified since the cutoff, not the one before it.
    expect(cellOf(result, "missouri", "MO")).toMatchObject({ candidates: 2, sendable: 2 });
    expect(cellOf(result, "selfAttested", "TX")).toMatchObject({ candidates: 1, sendable: 1 });
    expect(result.plan?.totals).toMatchObject({ candidates: 12, sendable: 8 });

    // --no-self-attested leaves out the users who picked a district, not the capped ones.
    const withoutSelfAttested = await run(["--no-self-attested"]);
    expect(cellOf(withoutSelfAttested, "verified", "CA")).toMatchObject({ candidates: 3, sendable: 2 });
    expect(withoutSelfAttested.plan?.totals).toMatchObject({ candidates: 10, sendable: 6 });
    const withoutMissouri = await run(["--no-missouri"]);
    expect(withoutMissouri.plan?.totals).toMatchObject({ candidates: 10, sendable: 6 });

    // Each claim holds: all eight are sent.
    const send = await run(applyArgs(8));
    expect(send.send).toMatchObject({ claimed: 8, usersSent: 8, claimSkipped: 0, stopped: null });
    for (const userId of ["user-ca-3", "user-mo-3", "user-tx-3"]) {
      expect(pii.get(userId)?.[MARKER_ATTRIBUTE]).toBeDefined();
    }
    for (const userId of ["user-mo-4", "user-ny-3"]) expect(pii.get(userId)?.[MARKER_ATTRIBUTE]).toBeUndefined();
    expectNoSecrets(lines.join("\n"));
  });

  test("refuses a summary file that exists", async () => {
    await run(["--summary-file", summaryPath()]);
    const result = await run(["--summary-file", summaryPath()]);
    expect(result.exitCode).toBe(2);
    expect(result.refusal).toMatch(/exists/);
    expect(scans).toHaveLength(2);
  });
});

describe("the marker claim", () => {
  const audience: AudienceOptions = { missouriSince: "2026-04-01T00:00:00.000Z", selfAttested: true };
  const nowIso = "2027-01-04T17:00:00.000Z";
  const claimHolds = (item: Item | undefined, candidate: Candidate) =>
    evaluateCondition(item, claimMarkerInput(PII, candidate, audience, nowIso));
  const candidateOf = (item: Item): Candidate => {
    const candidate = classifyUser(item, audience);
    if (!candidate) throw new Error("not a candidate");
    return candidate;
  };

  test("sets only the marker", () => {
    const input = claimMarkerInput(PII, candidateOf(verified("u", "CA")), audience, nowIso);
    expect(input.UpdateExpression).toBe("SET #marker = :now");
    expect(input.ExpressionAttributeNames["#marker"]).toBe("districtNotice2027At");
    expect(input.ExpressionAttributeValues[":now"]).toEqual({ S: nowIso });
    expect(input.Key).toEqual({ userId: { S: "u" } });
  });

  test("holds once for a user still in the audience, and not again", () => {
    const item = verified("u", "CA");
    const candidate = candidateOf(item);
    expect(claimHolds(item, candidate)).toBe(true);
    expect(claimHolds({ ...item, [MARKER_ATTRIBUTE]: { S: nowIso } }, candidate)).toBe(false);
  });

  test("fails for a user who left the group or state, or is being deleted", () => {
    const item = verified("u", "CA");
    const candidate = candidateOf(item);
    expect(claimHolds(undefined, candidate)).toBe(false);
    expect(claimHolds(verified("u", "NV"), candidate)).toBe(false);
    expect(claimHolds(selfAttested("u", "CA"), candidate)).toBe(false);
    expect(claimHolds({ ...item, constituentVerified: { BOOL: false } }, candidate)).toBe(false);
    expect(claimHolds({ ...item, deletionStatus: { S: "in_progress" } }, candidate)).toBe(false);
    expect(claimHolds({ ...item, deletionStatus: { S: "completed" } }, candidate)).toBe(false);
    expect(claimHolds({ ...item, deletionStatus: { S: "failed" } }, candidate)).toBe(true);
  });

  test("checks the Missouri cutoff and the self-attested state", () => {
    const missouri = verified("u", "MO", { verifiedAt: { S: "2026-05-10T09:00:00.000Z" } });
    const missouriCandidate = candidateOf(missouri);
    expect(missouriCandidate.group).toBe("missouri");
    expect(claimHolds(missouri, missouriCandidate)).toBe(true);
    expect(claimHolds({ ...missouri, verifiedAt: { S: "2026-03-31T23:59:59.000Z" } }, missouriCandidate)).toBe(false);

    const self = selfAttested("u", "OH");
    const selfCandidate = candidateOf(self);
    expect(selfCandidate.group).toBe("selfAttested");
    expect(claimHolds(self, selfCandidate)).toBe(true);
    expect(claimHolds(selfAttested("u", "PA"), selfCandidate)).toBe(false);
    expect(claimHolds(verified("u", "OH"), selfCandidate)).toBe(false);
    expect(claimHolds(capped("u", "OH"), selfCandidate)).toBe(false);
  });

  test("reads a legacy self-attested row's state from resolvedState, in the group and in the claim", () => {
    const legacy = legacySelfAttested("u", "TX");
    const candidate = candidateOf(legacy);
    expect(candidate).toMatchObject({ group: "selfAttested", state: "TX" });
    expect(claimHolds(legacy, candidate)).toBe(true);
    // A pick since then is in selfAttestedState, which wins over the old resolvedState.
    expect(claimHolds({ ...legacy, selfAttestedState: { S: "PA" } }, candidate)).toBe(false);
    expect(claimHolds({ ...legacy, resolvedState: { S: "PA" } }, candidate)).toBe(false);
    expect(classifyUser(legacySelfAttested("u", "NY"), audience)).toBeNull();
    expect(classifyUser(legacy, { ...audience, selfAttested: false })).toBeNull();
  });

  test("puts a capped user in the verified or Missouri group, by the geocoded selfAttestedState", () => {
    const cappedUser = capped("u", "UT");
    const candidate = candidateOf(cappedUser);
    expect(candidate).toMatchObject({ group: "verified", state: "UT" });
    expect(claimHolds(cappedUser, candidate)).toBe(true);
    // Verified by address in the same state since: still in the group.
    expect(claimHolds(verified("u", "UT"), candidate)).toBe(true);
    expect(claimHolds(capped("u", "NV"), candidate)).toBe(false);
    expect(claimHolds(selfAttested("u", "UT"), candidate)).toBe(false);
    expect(claimHolds({ ...cappedUser, deletionStatus: { S: "in_progress" } }, candidate)).toBe(false);
    // --no-self-attested does not reach it.
    expect(classifyUser(cappedUser, { ...audience, selfAttested: false })).toMatchObject({ group: "verified" });

    const missouri = capped("u", "MO", { verifiedAt: { S: "2026-05-10T09:00:00.000Z" } });
    const missouriCandidate = candidateOf(missouri);
    expect(missouriCandidate).toMatchObject({ group: "missouri", state: "MO" });
    expect(claimHolds(missouri, missouriCandidate)).toBe(true);
    expect(claimHolds({ ...missouri, verifiedAt: { S: "2026-03-31T23:59:59.000Z" } }, missouriCandidate)).toBe(false);
    expect(classifyUser({ ...missouri, verifiedAt: { S: "2026-03-01T09:00:00.000Z" } }, audience)).toBeNull();
    expect(classifyUser(missouri, { ...audience, missouriSince: null })).toBeNull();
  });

  test("uses every name and value it sends, as DynamoDB requires", () => {
    const items = [
      verified("u", "CA"),
      verified("u", "MO", { verifiedAt: { S: "2026-05-10T09:00:00.000Z" } }),
      capped("u", "UT"),
      selfAttested("u", "OH"),
      legacySelfAttested("u", "TX"),
    ];
    for (const item of items) {
      const input = claimMarkerInput(PII, candidateOf(item), audience, nowIso);
      const expressions = `${input.ConditionExpression} ${input.UpdateExpression}`;
      for (const token of [
        ...Object.keys(input.ExpressionAttributeNames),
        ...Object.keys(input.ExpressionAttributeValues),
      ]) {
        expect(expressions).toMatch(new RegExp(`${token}(?![A-Za-z0-9_])`));
      }
    }
  });
});

describe("the send window", () => {
  const states = audienceStates({ missouriSince: "2026-04-01T00:00:00.000Z", selfAttested: true });

  test.each([
    ["2026-12-29T17:00:00.000Z", /has not started/],
    ["2027-01-03T16:59:59.000Z", /has not started/],
    ["2027-01-04T15:59:59.000Z", /send window/],
    ["2027-01-05T00:00:00.000Z", /send window/],
  ])("refuses at %s", (time, reason) => {
    expect(sendWindowRefusal(Date.parse(time), states)).toMatch(reason);
  });

  test.each([CONGRESS_START, "2027-01-04T16:00:00.000Z", "2027-01-04T23:59:59.000Z"])("allows %s", (time) => {
    expect(sendWindowRefusal(Date.parse(time), states)).toBeNull();
  });

  test("is outside quiet hours in every audience state, every minute of Jan 4 and 5", () => {
    for (const day of ["2027-01-04", "2027-01-05"]) {
      const start = Date.parse(`${day}T16:00:00.000Z`);
      for (let minute = 0; minute < 8 * 60; minute += 1) {
        for (const state of states) {
          expect(isInQuietHours(start + minute * 60_000, timeZoneForState(state))).toBe(false);
        }
      }
    }
  });

  test("refuses a state in its quiet hours", () => {
    expect(sendWindowRefusal(Date.parse("2027-01-04T16:00:00.000Z"), [...states, "HI"])).toBe("quiet hours in HI");
  });
});

describe("--apply", () => {
  test.each([
    ["before the 120th Congress starts", "2026-12-29T17:00:00.000Z"],
    ["outside 16:00-23:59Z", "2027-01-04T15:30:00.000Z"],
  ])("refuses %s, reading and writing nothing", async (_reason, time) => {
    clock = Date.parse(time);
    const result = await run(applyArgs(5));
    expect(result.exitCode).toBe(2);
    expect(events).toEqual([]);
    expect(existsSync(summaryPath())).toBe(false);
  });

  test("refuses when the sendable count changed, and leaves no summary file", async () => {
    const result = await run(applyArgs(4));
    expect(result).toMatchObject({ exitCode: 2, refusal: expect.stringContaining("sendable=5, not the expected 4") });
    expect(writes()).toEqual([]);
    expect(existsSync(summaryPath())).toBe(false);
  });

  test("refuses a summary file it cannot create, before reading or sending anything", async () => {
    const missing = join(dir, "missing", "summary.json");
    const result = await run(["--apply", "--expect-sendable", "5", "--summary-file", missing]);
    expect(result).toMatchObject({ exitCode: 2, refusal: expect.stringContaining("ENOENT") });
    expect(events).toEqual([]);
    expect(sns.send).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });

  test("creates the summary file before the first claim, and fills it in at the end", async () => {
    const seen: string[] = [];
    beforeUpdate = () => {
      seen.push(JSON.parse(readFileSync(summaryPath(), "utf8")).status);
    };
    await run(applyArgs(5));
    expect(seen[0]).toBe("started");
    expect(JSON.parse(readFileSync(summaryPath(), "utf8"))).toMatchObject({
      mode: "apply",
      status: "finished",
      send: { claimed: 5, stopped: null },
    });
  });

  test("claims each user's marker before publishing, paced, and writes counts only", async () => {
    const result = await run(applyArgs(5));
    expect(result.exitCode).toBe(0);
    expect(result.send).toMatchObject({
      claimed: 5,
      usersSent: 5,
      usersNotDelivered: 0,
      claimSkipped: 0,
      notReached: 0,
      stopped: null,
    });
    expect(result.send?.devices).toMatchObject({ sent: 5, disabled: 0, failed: 0 });

    const claimed = ["user-ca-1", "user-fl-1", "user-la-1", "user-mo-1", "user-oh-1"];
    for (const userId of claimed) {
      expect(pii.get(userId)?.[MARKER_ATTRIBUTE]).toBeDefined();
      const claimAt = events.findIndex((event) => event.type === "claim" && event.userId === userId);
      const publishAt = events.findIndex((event) => event.type === "publish" && event.arn === arnOf(userId, "a"));
      expect(claimAt).toBeGreaterThanOrEqual(0);
      expect(publishAt).toBeGreaterThan(claimAt);
    }
    // The user marked before, and the users not reached, keep their rows as they were.
    expect(pii.get("user-tx-2")?.[MARKER_ATTRIBUTE]).toEqual({ S: "2027-01-04T16:10:00.000Z" });
    expect(pii.get("user-ca-2")?.[MARKER_ATTRIBUTE]).toBeUndefined();
    expect(publishes.map((input) => input.TargetArn)).not.toContain(arnOf("user-fl-1", "b"));
    // About 5 users a second.
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(4 * USER_PACE_MS);
    expect(clock - SEND_TIME).toBeGreaterThanOrEqual(4 * USER_PACE_MS);

    const summary = readFileSync(summaryPath(), "utf8");
    expectNoSecrets(summary);
    expectNoSecrets(lines.join("\n"));
    expect(JSON.parse(summary)).toMatchObject({ mode: "apply", send: { claimed: 5, usersSent: 5 } });
  });

  test("publishes userNotifier's message shape, with no billIds", async () => {
    await run(applyArgs(5));
    expect(publishes).toHaveLength(5);
    for (const input of publishes) {
      expect(input.MessageStructure).toBe("json");
      expect(input.Message).toBe(noticeMessage());
      const message = JSON.parse(input.Message ?? "{}");
      expect(Object.keys(message).sort()).toEqual(["APNS", "APNS_SANDBOX", "default"]);
      expect(message.default).toBe(NOTICE_TITLE);
      expect(message.APNS_SANDBOX).toBe(message.APNS);
      const apns = JSON.parse(message.APNS);
      expect(apns).toEqual(noticeApnsPayload());
      expect(apns).toEqual({
        aps: { alert: { title: NOTICE_TITLE, body: NOTICE_BODY }, sound: "default", "thread-id": "district" },
        domain: "district_check",
      });
      for (const key of ["billIds", "billId", "digestId", "notificationType", "billCount"]) {
        expect(apns).not.toHaveProperty(key);
      }
    }
  });

  test("skips a user whose claim fails, sending nothing to them", async () => {
    // Another run marks the user between this run's scan and its claim.
    beforeUpdate = (userId) => {
      if (userId === "user-ca-1") {
        pii.set(userId, { ...pii.get(userId)!, [MARKER_ATTRIBUTE]: { S: "2027-01-04T16:59:00.000Z" } });
      }
    };
    const result = await run(applyArgs(5));
    expect(result.send).toMatchObject({ claimed: 4, usersSent: 4, claimSkipped: 1, stopped: null });
    expect(publishes.map((input) => input.TargetArn)).not.toContain(arnOf("user-ca-1", "a"));
  });

  test("counts a disabled endpoint and writes no device row", async () => {
    publishErrors.set(
      arnOf("user-fl-1", "a"),
      Object.assign(new Error("Endpoint is disabled"), { name: "EndpointDisabledException" }),
    );
    const result = await run(applyArgs(5));
    expect(result.exitCode).toBe(0);
    expect(result.send).toMatchObject({ claimed: 5, usersSent: 4, usersNotDelivered: 1, notReached: 0 });
    expect(result.send?.devices).toMatchObject({ sent: 4, disabled: 1, failed: 0 });
    expect(events.filter((event) => event.table === DEVICES && event.type !== "query")).toEqual([]);
  });

  test("stops at the first failed publish, printing the error's name and no ARN", async () => {
    publishErrors.set(
      arnOf("user-ca-1", "a"),
      Object.assign(new Error(`Invalid parameter: TargetArn ${arnOf("user-ca-1", "a")}`), {
        name: "InternalErrorException",
      }),
    );
    const result = await run(applyArgs(5));
    expect(result.exitCode).toBe(1);
    expect(result.send).toMatchObject({
      claimed: 1,
      usersSent: 0,
      usersNotDelivered: 1,
      notReached: 4,
      stopped: "a publish failed",
    });
    expect(publishes).toEqual([]);
    expect(lines).toContain("Publish error InternalErrorException: 1");
    expectNoSecrets(lines.join("\n"));
    expectNoSecrets(readFileSync(summaryPath(), "utf8"));
  });

  test("stops when the window closes", async () => {
    clock = Date.parse("2027-01-04T23:59:59.400Z");
    const result = await run(applyArgs(5));
    expect(result.exitCode).toBe(1);
    expect(result.send).toMatchObject({ claimed: 3, usersSent: 3, notReached: 2 });
    expect(result.send?.stopped).toMatch(/send window/);
  });

  test("on an interrupt, finishes the user in flight, then stops and writes the counts", async () => {
    // The signal comes while the first user's marker is claimed.
    let interrupted = false;
    beforeUpdate = () => {
      interrupted = true;
    };
    const result = await run(applyArgs(5), {}, { interrupted: () => interrupted });
    expect(result.exitCode).toBe(1);
    expect(result.send).toMatchObject({ claimed: 1, usersSent: 1, notReached: 4, stopped: INTERRUPTED });
    // The user in flight has both the marker and the push.
    const [claim] = events.filter((event) => event.type === "claim");
    expect(publishes.map((input) => input.TargetArn)).toEqual([arnOf(claim.userId!, "a")]);
    expect(lines).toContainEqual(expect.stringMatching(/^District notice send: claimed=1 .*stopped=interrupted$/));
    expect(JSON.parse(readFileSync(summaryPath(), "utf8"))).toMatchObject({
      status: "finished",
      send: { claimed: 1, notReached: 4, stopped: INTERRUPTED },
    });
  });

  test("on an interrupt before the first user, sends nothing and still writes the counts", async () => {
    const result = await run(applyArgs(5), {}, { interrupted: () => true });
    expect(result.send).toMatchObject({ claimed: 0, notReached: 5, stopped: INTERRUPTED });
    expect(writes()).toEqual([]);
    expect(JSON.parse(readFileSync(summaryPath(), "utf8"))).toMatchObject({ send: { notReached: 5 } });
  });
});

describe("--canary", () => {
  test("publishes to the operator's own devices and writes no marker", async () => {
    const result = await run(["--canary"], { canarySub: "canary-sub-0001" });
    expect(result.exitCode).toBe(0);
    expect(result.canary).toMatchObject({ devices: 2, sendable: 1, notificationsOff: 1, publish: { sent: 1 } });
    expect(publishes.map((input) => input.TargetArn)).toEqual([arnOf("canary-sub-0001", "a")]);
    expect(publishes[0].Message).toBe(noticeMessage());
    expect(events.filter((event) => event.type === "claim" || event.type === "scan")).toEqual([]);
    expect([...pii.values()].filter((item) => item[MARKER_ATTRIBUTE] !== undefined)).toHaveLength(1);
    expectNoSecrets(lines.join("\n"));
  });

  test("refuses without NOTICE_CANARY_SUB", async () => {
    const result = await run(["--canary"]);
    expect(result.exitCode).toBe(2);
    expect(sns.send).not.toHaveBeenCalled();
  });

  test("fails when no device took the push", async () => {
    const result = await run(["--canary"], { canarySub: "user-ca-2" });
    expect(result.exitCode).toBe(1);
  });
});

describe("--clear-markers", () => {
  test("counts the markers per state and writes nothing", async () => {
    const result = await run(["--clear-markers"]);
    expect(result.markers).toMatchObject({ markers: 1, byState: { TX: 1 } });
    expect(writes()).toEqual([]);
    expectNoSecrets(lines.join("\n"));
  });

  test("refuses a marker count that changed, and leaves no summary file", async () => {
    const result = await run(["--clear-markers", "--apply", "--expect-markers", "2", "--summary-file", summaryPath()]);
    expect(result.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(existsSync(summaryPath())).toBe(false);
  });

  test("on an interrupt, finishes the marker in flight, then stops and writes the counts", async () => {
    await run(applyArgs(5));
    // The signal comes while the first marker is removed.
    let interrupted = false;
    beforeUpdate = () => {
      interrupted = true;
    };
    const clearSummary = join(dir, "clear.json");
    const result = await run(
      ["--clear-markers", "--apply", "--expect-markers", "6", "--summary-file", clearSummary],
      {},
      { interrupted: () => interrupted },
    );
    expect(result.exitCode).toBe(1);
    expect(result.markers).toMatchObject({ markers: 6, cleared: 1, notReached: 5, stopped: INTERRUPTED });
    expect([...pii.values()].filter((item) => item[MARKER_ATTRIBUTE] !== undefined)).toHaveLength(5);
    expect(JSON.parse(readFileSync(clearSummary, "utf8"))).toMatchObject({
      status: "finished",
      markers: { cleared: 1, notReached: 5, stopped: INTERRUPTED },
    });
  });

  test("removes every marker, each on condition that it is there", async () => {
    await run(applyArgs(5));
    const clearSummary = join(dir, "clear.json");
    const result = await run(["--clear-markers", "--apply", "--expect-markers", "6", "--summary-file", clearSummary]);
    expect(result.exitCode).toBe(0);
    expect(result.markers).toMatchObject({ markers: 6, cleared: 6, gone: 0 });
    expect([...pii.values()].filter((item) => item[MARKER_ATTRIBUTE] !== undefined)).toEqual([]);
    const removes = dynamoSend.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input.UpdateExpression === "REMOVE #marker");
    expect(removes).toHaveLength(6);
    for (const input of removes) expect(input.ConditionExpression).toBe("attribute_exists(#marker)");
    expectNoSecrets(readFileSync(clearSummary, "utf8"));
  });
});

describe("watchInterrupts", () => {
  const fakeProcess = () => {
    const emitter = new EventEmitter();
    const exit = jest.fn();
    const proc = Object.assign(emitter, { exit }) as unknown as Pick<NodeJS.Process, "on" | "exit">;
    return { proc, emitter, exit };
  };

  test.each(["apply", "clear-markers"] as const)(
    "lets %s finish the user in flight on the first signal, and exits on the second",
    (mode) => {
      const { proc, emitter, exit } = fakeProcess();
      const warnings: string[] = [];
      const interrupted = watchInterrupts(mode, proc, (line) => warnings.push(line));
      expect(interrupted()).toBe(false);
      emitter.emit("SIGINT", "SIGINT");
      expect(interrupted()).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      expect(warnings).toEqual(["SIGINT: finishing the user in flight, then stopping (again to exit at once)"]);
      emitter.emit("SIGTERM", "SIGTERM");
      expect(exit).toHaveBeenCalledWith(130);
    },
  );

  test.each(["dry-run", "canary", "markers"] as const)("leaves %s to stop at once", (mode) => {
    const { proc, emitter } = fakeProcess();
    expect(watchInterrupts(mode, proc)()).toBe(false);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("redact", () => {
  test("takes ARNs and subs out of an error message", () => {
    expect(
      redact(
        "Invalid parameter: TargetArn arn:aws:sns:us-east-1:1:endpoint/APNS/App/x, key 4f6d2c1e-9a8b-4c7d-8e6f-0a1b2c3d4e5f",
      ),
    ).toBe("Invalid parameter: TargetArn <arn>, key <id>");
  });
});
