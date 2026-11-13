#!/usr/bin/env node

// The one-time "Your district may have changed" push of the 120th Congress (REL-46, decision 4; ../docs/RUNBOOK.md
// 24.5). Nothing else can send it: userNotifier sends pending bill rows only.
//
//   npm run send:district-notice                          dry run (the default; reads only)
//   npm run send:district-notice -- --canary              the operator's own devices only; no marker
//   npm run send:district-notice -- --apply --expect-sendable <N> --summary-file <path>
//   npm run send:district-notice -- --clear-markers       counts the markers (reads only)
//   npm run send:district-notice -- --clear-markers --apply --expect-markers <N> --summary-file <path>
//
// The audience is project decision D9, still open. Each group has a switch; the defaults are the plan's recommendation:
// - verified: users whose district the geocoder set, in one of the nine states with new House maps (NEW_MAP_STATES):
//   verified by address (`address_geocode`, resolvedState), or geocoded past the address limit (`address_capped`,
//   selfAttestedState; not counted as verified, but the district is the geocoder's all the same);
// - missouri: the same in Missouri, verified on or after --missouri-since (2026-04-01). The geocoder's 120th layer
//   gave them a map that is not in effect, until REL-46 PR 1 pinned Missouri. --no-missouri leaves them out;
// - selfAttested: users who picked their state and district themselves (verificationStatus self_attested, not
//   `address_capped`), in the nine states: selfAttestedState, or resolvedState on rows from before 2026-03-23, which
//   kept it there. They picked from the old map. --no-self-attested leaves them out.
// A user being deleted (deletionStatus in_progress or completed) is left out. A user with the districtNotice2027At
// marker counts as alreadySent.
//
// The dry run scans UserPII (no index; it reads only the fields above, never a district or address) and queries each
// candidate's devices. A user is sendable with at least one device that has an SNS endpoint and notificationsEnabled
// not false (the master switch only, D13: this push is not a bill type), notificationsOff when every such device has
// it false, and noDevice otherwise. It prints counts per group and state, and the wording. It never prints an id, an
// endpoint ARN, a district or an address, and neither does any other mode.
//
// --apply refuses (exit 2, nothing written) before the 120th Congress starts (2027-01-03T17:00Z; the wording says it
// began), outside 16:00-23:59Z (daytime in every audience state, checked with the quiet-hours helper), when
// --summary-file exists or cannot be created, or when the sendable count is not --expect-sendable (run the dry run
// again). Then, per sendable user, about 5 a second while the window lasts: it claims the marker with a conditional
// UpdateItem (absent, and the user still in the same group and state and not being deleted), and only then publishes
// to each sendable device in userNotifier's message shape. A user whose claim fails is skipped, so a user gets the
// push at most once. It stops at the first failed publish or claim error. It writes no device row (a disabled endpoint
// is counted and left to userNotifier) and writes counts only to --summary-file, which it creates before reading
// anything and fills in at the end, also when the run stops early.
//
// A writing run (--apply, --clear-markers --apply) is not killed by the first Ctrl-C (or SIGTERM): it finishes the
// user in flight, then stops (stopped=interrupted) and writes the summary. The second exits at once.
//
// --canary publishes to the devices of NOTICE_CANARY_SUB (the operator's own account; never printed). It reads no
// UserPII and writes no marker.
//
// --clear-markers --apply removes every marker. Run it only with the project's approval: a sent push cannot be recalled,
// and a user without a marker gets the push again.
//
// Exit codes: 0 done, 1 the run stopped early (a failed publish or write, the window closed, or interrupted) or the
// canary reached no device, 2 refused.
//
// Environment: AWS_REGION (us-east-1), PII_TABLE_NAME (UserPII), DEVICE_TABLE_NAME (UserDevices), NOTICE_CANARY_SUB.

import { rmSync, writeFileSync } from "node:fs";

import { type AttributeValue, DynamoDBClient, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

import { UserDeviceDao, type UserDeviceRecord } from "../src/adapters/userDeviceDao";
import { normalizeDeletionStatus } from "../src/shared/adultEligibility";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { isInQuietHours, timeZoneForState } from "../src/shared/quietHours";

/** The states with new House maps from the 120th Congress (the Census Bureau's list, checked 2026-11-05). */
export const NEW_MAP_STATES: readonly string[] = Object.freeze(["AL", "CA", "FL", "LA", "NC", "OH", "TN", "TX", "UT"]);
export const MISSOURI = "MO";
/** D9's recommended cutoff: DistrictVerification's logs (kept one month) cannot date the geocoder's switch. */
export const DEFAULT_MISSOURI_SINCE = "2026-04-01";
export const MARKER_ATTRIBUTE = "districtNotice2027At";
/** Noon Eastern on Jan 3: the 120th Congress starts. */
export const CONGRESS_START = "2027-01-03T17:00:00.000Z";
/** The send window is 16:00-23:59Z: 11:00 to 18:59 Eastern, 8:00 to 15:59 Pacific in January. */
export const SEND_WINDOW_START_HOUR_UTC = 16;
/** About 5 users a second. */
export const USER_PACE_MS = 200;

/** D10, still open: true for every group (Missouri's map did not change, the nine states' did). */
export const NOTICE_TITLE = "Your district may have changed";
export const NOTICE_BODY =
  "The new Congress began Jan 3, with new House maps in some states. Open Profile and check where you vote.";

const PII_PARTITION_KEY = "userId";
const DEVICE_SORT_KEY = "deviceId";
const SNS_ENDPOINT_ARN_SEGMENT = ":endpoint/";
const DEVICE_QUERY_CONCURRENCY = 4;

export interface NoticeConfig {
  region: string;
  piiTableName: string;
  deviceTableName: string;
  /** The operator's own account for --canary; never printed. */
  canarySub: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): NoticeConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  piiTableName: env.PII_TABLE_NAME || "UserPII",
  deviceTableName: env.DEVICE_TABLE_NAME || "UserDevices",
  canarySub: (env.NOTICE_CANARY_SUB ?? "").trim(),
});

export type Mode = "dry-run" | "canary" | "apply" | "markers" | "clear-markers";

export interface AudienceOptions {
  /** The first verifiedAt (an ISO time) of the Missouri group; null leaves the group out. */
  missouriSince: string | null;
  selfAttested: boolean;
}

export interface CliOptions {
  help: boolean;
  mode: Mode;
  expectSendable: number | null;
  expectMarkers: number | null;
  summaryFile: string | null;
  audience: AudienceOptions;
}

const USAGE = `Usage: npm run send:district-notice [-- <flags>]

  (no flag)                  Dry run: counts per group and state, and the wording; writes nothing
  --canary                   Publish to the devices of NOTICE_CANARY_SUB only; no marker
  --apply --expect-sendable <N> --summary-file <path>
                             Claim each sendable user's marker, then publish (16:00-23:59Z from 2027-01-03T17:00Z)
  --clear-markers            Count the markers per state; writes nothing
  --clear-markers --apply --expect-markers <N> --summary-file <path>
                             Remove every marker (project approval only)
  --summary-file <path>      Write the counts there (a new file, created first); needed with --apply
  --no-missouri              Leave out the Missouri group (D9)
  --missouri-since <date>    The Missouri group's first verification day, YYYY-MM-DD (default ${DEFAULT_MISSOURI_SINCE})
  --no-self-attested         Leave out the users who picked their district themselves (D9)
  --help                     Show this text

Environment: AWS_REGION (us-east-1), PII_TABLE_NAME (UserPII), DEVICE_TABLE_NAME (UserDevices), NOTICE_CANARY_SUB.`;

const missouriSinceTime = (day: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new Error(`--missouri-since needs a date as YYYY-MM-DD, not ${day}`);
  }
  return new Date(`${day}T00:00:00.000Z`).toISOString();
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  let help = false;
  let apply = false;
  let canary = false;
  let clearMarkers = false;
  let expectSendable: number | null = null;
  let expectMarkers: number | null = null;
  let summaryFile: string | null = null;
  let noMissouri = false;
  let missouriSince: string | null = null;
  let selfAttested = true;
  let audienceFlag = false;

  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value.trim();
  };
  const countOf = (flag: string, index: number): number => {
    const value = valueOf(flag, index);
    if (!/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number, not ${value}`);
    return Number(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--canary") canary = true;
    else if (arg === "--clear-markers") clearMarkers = true;
    else if (arg === "--expect-sendable") {
      expectSendable = countOf(arg, index);
      index += 1;
    } else if (arg === "--expect-markers") {
      expectMarkers = countOf(arg, index);
      index += 1;
    } else if (arg === "--summary-file") {
      summaryFile = valueOf(arg, index);
      index += 1;
    } else if (arg === "--no-missouri") {
      noMissouri = true;
      audienceFlag = true;
    } else if (arg === "--missouri-since") {
      missouriSince = missouriSinceTime(valueOf(arg, index));
      audienceFlag = true;
      index += 1;
    } else if (arg === "--no-self-attested") {
      selfAttested = false;
      audienceFlag = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (canary && (apply || clearMarkers)) throw new Error("--canary runs alone, without --apply or --clear-markers");
  if (canary && summaryFile !== null) throw new Error("--canary writes no summary; leave out --summary-file");
  if ((canary || clearMarkers) && audienceFlag) {
    throw new Error("The audience flags go with the dry run and --apply only");
  }
  if (noMissouri && missouriSince !== null) throw new Error("--no-missouri and --missouri-since contradict each other");
  let mode: Mode = apply ? "apply" : "dry-run";
  if (clearMarkers) mode = apply ? "clear-markers" : "markers";
  if (canary) mode = "canary";
  if (expectSendable !== null && mode !== "apply") throw new Error("--expect-sendable goes with --apply only");
  if (expectMarkers !== null && mode !== "clear-markers") {
    throw new Error("--expect-markers goes with --clear-markers --apply only");
  }
  if (mode === "apply" && expectSendable === null) {
    throw new Error("--apply needs --expect-sendable <N>, the sendable count of the dry run");
  }
  if (mode === "clear-markers" && expectMarkers === null) {
    throw new Error("--clear-markers --apply needs --expect-markers <N>, the marker count of --clear-markers");
  }
  if ((mode === "apply" || mode === "clear-markers") && summaryFile === null) {
    throw new Error("--apply needs --summary-file <path>");
  }

  return {
    help,
    mode,
    expectSendable,
    expectMarkers,
    summaryFile,
    audience: {
      missouriSince: noMissouri ? null : (missouriSince ?? missouriSinceTime(DEFAULT_MISSOURI_SINCE)),
      selfAttested,
    },
  };
};

// ─── Audience ──────────────────────────────────────────────────────────────────

type Item = Record<string, AttributeValue>;
type SnsSend = Pick<SNSClient, "send">;

export type AudienceGroup = "verified" | "missouri" | "selfAttested";

export interface Candidate {
  userId: string;
  group: AudienceGroup;
  state: string;
  alreadySent: boolean;
}

/** The UserPII fields the script reads; nothing else (no district, no address). */
const PII_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "#pk": PII_PARTITION_KEY,
  "#marker": MARKER_ATTRIBUTE,
  "#deletion": "deletionStatus",
  "#method": "verificationMethod",
  "#verified": "constituentVerified",
  "#status": "verificationStatus",
  "#verifiedAt": "verifiedAt",
  "#resolvedState": "resolvedState",
  "#selfState": "selfAttestedState",
});

export const scanUserPii = async (dynamo: Pick<DynamoDBClient, "send">, tableName: string): Promise<Item[]> => {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: Object.keys(PII_NAMES).join(", "),
        ExpressionAttributeNames: { ...PII_NAMES },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
};

const isNewMapState = (state: string | undefined): state is string =>
  state !== undefined && NEW_MAP_STATES.includes(state);

const GEOCODE_METHOD = "address_geocode";
/** Geocoded, but past the address limit: self-attested at the geocoded state and district (selfAttestedState). */
const CAPPED_METHOD = "address_capped";
const SELF_ATTESTED_STATUS = "self_attested";

/** Verified the way districtVerification records it: by address, and not marked unverified. */
const isAddressVerified = (item: Item): boolean =>
  item.verificationMethod?.S === GEOCODE_METHOD && item.constituentVerified?.BOOL !== false;

const isBeingDeleted = (item: Item): boolean => {
  const status = normalizeDeletionStatus(item.deletionStatus?.S);
  return status === "in_progress" || status === "completed";
};

/**
 * The user's group and state in the audience, or null. Matches the claim's condition (claimMarkerInput). The geocoder
 * set the district of an address-verified user (resolvedState) and of a capped one (selfAttestedState), so both are in
 * the verified and Missouri groups. Before 2026-03-23 the manual path stored the picked state in resolvedState, and no
 * migration moved it, so a self-attested row without selfAttestedState is read from resolvedState, as userNotifier and
 * districtVerification read it.
 */
export const classifyUser = (item: Item, audience: AudienceOptions): Candidate | null => {
  const userId = item[PII_PARTITION_KEY]?.S;
  if (!userId || isBeingDeleted(item)) return null;
  const alreadySent = item[MARKER_ATTRIBUTE] !== undefined;
  const candidate = (group: AudienceGroup, state: string): Candidate => ({ userId, group, state, alreadySent });

  const addressVerified = isAddressVerified(item);
  if (addressVerified || item.verificationMethod?.S === CAPPED_METHOD) {
    const state = addressVerified ? item.resolvedState?.S : item.selfAttestedState?.S;
    if (isNewMapState(state)) return candidate("verified", state);
    const verifiedAt = item.verifiedAt?.S;
    if (
      state === MISSOURI &&
      audience.missouriSince !== null &&
      verifiedAt !== undefined &&
      verifiedAt >= audience.missouriSince
    ) {
      return candidate("missouri", state);
    }
    return null;
  }

  const selfState = item.selfAttestedState?.S ?? item.resolvedState?.S;
  if (audience.selfAttested && item.verificationStatus?.S === SELF_ATTESTED_STATUS && isNewMapState(selfState)) {
    return candidate("selfAttested", selfState);
  }
  return null;
};

/** The groups and states the options include, in print order. */
export const audienceCells = (audience: AudienceOptions): { group: AudienceGroup; state: string }[] => [
  ...NEW_MAP_STATES.map((state) => ({ group: "verified" as const, state })),
  ...(audience.missouriSince !== null ? [{ group: "missouri" as const, state: MISSOURI }] : []),
  ...(audience.selfAttested ? NEW_MAP_STATES.map((state) => ({ group: "selfAttested" as const, state })) : []),
];

/** Every state whose users the options can reach. */
export const audienceStates = (audience: AudienceOptions): string[] => [
  ...NEW_MAP_STATES,
  ...(audience.missouriSince !== null ? [MISSOURI] : []),
];

// ─── Devices ───────────────────────────────────────────────────────────────────

export type Reach = "sendable" | "noDevice" | "notificationsOff";

const hasEndpoint = (device: UserDeviceRecord): device is UserDeviceRecord & { endpointArn: string } =>
  typeof device.endpointArn === "string" && device.endpointArn.includes(SNS_ENDPOINT_ARN_SEGMENT);

/** The devices the push goes to: an SNS endpoint, and the master switch not off (D13). */
export const sendableDevices = (devices: readonly UserDeviceRecord[]): (UserDeviceRecord & { endpointArn: string })[] =>
  devices.filter(hasEndpoint).filter((device) => device.notificationsEnabled !== false);

export const reachOf = (devices: readonly UserDeviceRecord[]): Reach => {
  if (sendableDevices(devices).length > 0) return "sendable";
  return devices.some(hasEndpoint) ? "notificationsOff" : "noDevice";
};

// ─── Plan ──────────────────────────────────────────────────────────────────────

export interface CellCounts {
  group: AudienceGroup;
  state: string;
  candidates: number;
  alreadySent: number;
  sendable: number;
  noDevice: number;
  notificationsOff: number;
}

export interface PlanTotals {
  candidates: number;
  alreadySent: number;
  sendable: number;
  noDevice: number;
  notificationsOff: number;
  /** Every marker in UserPII, in the audience or not. */
  markers: number;
}

interface SendableUser extends Candidate {
  endpointArns: string[];
}

export interface AudiencePlan {
  cells: CellCounts[];
  totals: PlanTotals;
  /** Holds ids and ARNs: used to send, never printed or written. */
  sendable: SendableUser[];
}

export const planAudience = async (
  dynamo: DynamoDBClient,
  config: NoticeConfig,
  audience: AudienceOptions,
): Promise<AudiencePlan> => {
  const items = await scanUserPii(dynamo, config.piiTableName);
  const candidates = items
    .map((item) => classifyUser(item, audience))
    .filter((candidate): candidate is Candidate => candidate !== null);
  const deviceDao = new UserDeviceDao(dynamo, {
    tableName: config.deviceTableName,
    userIdAttribute: PII_PARTITION_KEY,
    deviceIdAttribute: DEVICE_SORT_KEY,
  });
  const toReach = candidates.filter((candidate) => !candidate.alreadySent);
  const devices = await mapWithConcurrency(toReach, DEVICE_QUERY_CONCURRENCY, (candidate) =>
    deviceDao.getDevicesForUser(candidate.userId),
  );

  const cells = audienceCells(audience).map(
    ({ group, state }): CellCounts => ({
      group,
      state,
      candidates: 0,
      alreadySent: 0,
      sendable: 0,
      noDevice: 0,
      notificationsOff: 0,
    }),
  );
  const cellOf = (candidate: Candidate): CellCounts => {
    const cell = cells.find((entry) => entry.group === candidate.group && entry.state === candidate.state);
    if (!cell) throw new Error(`No count for group ${candidate.group} in ${candidate.state}`);
    return cell;
  };
  for (const candidate of candidates) {
    const cell = cellOf(candidate);
    cell.candidates += 1;
    if (candidate.alreadySent) cell.alreadySent += 1;
  }
  const sendable: SendableUser[] = [];
  toReach.forEach((candidate, index) => {
    const reach = reachOf(devices[index]);
    cellOf(candidate)[reach] += 1;
    if (reach === "sendable") {
      sendable.push({
        ...candidate,
        endpointArns: sendableDevices(devices[index]).map((device) => device.endpointArn),
      });
    }
  });

  const sum = (key: keyof Omit<CellCounts, "group" | "state">) => cells.reduce((total, cell) => total + cell[key], 0);
  return {
    cells,
    totals: {
      candidates: sum("candidates"),
      alreadySent: sum("alreadySent"),
      sendable: sum("sendable"),
      noDevice: sum("noDevice"),
      notificationsOff: sum("notificationsOff"),
      markers: items.filter((item) => item[MARKER_ATTRIBUTE] !== undefined).length,
    },
    sendable,
  };
};

// ─── Window, claim and publish ─────────────────────────────────────────────────

/** Why a send cannot go now, or null. */
export const sendWindowRefusal = (nowMs: number, states: readonly string[]): string | null => {
  if (nowMs < Date.parse(CONGRESS_START)) return `the 120th Congress has not started (${CONGRESS_START})`;
  if (new Date(nowMs).getUTCHours() < SEND_WINDOW_START_HOUR_UTC) return "outside the send window, 16:00-23:59Z";
  const quiet = states.filter((state) => isInQuietHours(nowMs, timeZoneForState(state)));
  if (quiet.length > 0) return `quiet hours in ${quiet.join(", ")}`;
  return null;
};

/**
 * The marker claim: set only when there is none yet and the user is still in the same group and state, and not being
 * deleted. A user missing from the table fails it too (attribute_exists), so UpdateItem never creates a row.
 */
export const claimMarkerInput = (
  tableName: string,
  candidate: Candidate,
  audience: AudienceOptions,
  nowIso: string,
) => {
  const names: Record<string, string> = {
    "#pk": PII_PARTITION_KEY,
    "#marker": MARKER_ATTRIBUTE,
    "#deletion": "deletionStatus",
  };
  const values: Record<string, AttributeValue> = {
    ":now": { S: nowIso },
    ":state": { S: candidate.state },
    ":inProgress": { S: "in_progress" },
    ":completed": { S: "completed" },
  };
  const conditions = [
    "attribute_exists(#pk)",
    "attribute_not_exists(#marker)",
    "(attribute_not_exists(#deletion) OR (#deletion <> :inProgress AND #deletion <> :completed))",
  ];
  // Every group reads the state from the attribute classifyUser took it from.
  names["#method"] = "verificationMethod";
  names["#resolvedState"] = "resolvedState";
  names["#selfState"] = "selfAttestedState";
  values[":capped"] = { S: CAPPED_METHOD };
  if (candidate.group === "selfAttested") {
    names["#status"] = "verificationStatus";
    values[":selfAttested"] = { S: SELF_ATTESTED_STATUS };
    conditions.push(
      "#status = :selfAttested",
      "(attribute_not_exists(#method) OR #method <> :capped)",
      "(#selfState = :state OR (attribute_not_exists(#selfState) AND #resolvedState = :state))",
    );
  } else {
    names["#verified"] = "constituentVerified";
    values[":geocode"] = { S: GEOCODE_METHOD };
    values[":true"] = { BOOL: true };
    conditions.push(
      "((#method = :geocode AND #resolvedState = :state AND (attribute_not_exists(#verified) OR #verified = :true))" +
        " OR (#method = :capped AND #selfState = :state))",
    );
    if (candidate.group === "missouri") {
      if (audience.missouriSince === null) throw new Error("A Missouri candidate without the Missouri group");
      names["#verifiedAt"] = "verifiedAt";
      values[":since"] = { S: audience.missouriSince };
      conditions.push("#verifiedAt >= :since");
    }
  }
  return {
    TableName: tableName,
    Key: { [PII_PARTITION_KEY]: { S: candidate.userId } },
    UpdateExpression: "SET #marker = :now",
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

const errorName = (error: unknown): string =>
  error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "Error";

const isConditionFailure = (error: unknown): boolean => errorName(error) === "ConditionalCheckFailedException";

/** The APNs payload: no billIds, digestId or notificationType, so 1.1 and 1.2 show it and a tap opens the app. */
export const noticeApnsPayload = () => ({
  aps: {
    alert: { title: NOTICE_TITLE, body: NOTICE_BODY },
    sound: "default",
    "thread-id": "district",
  },
  domain: "district_check",
});

/** userNotifier's message shape (publishToDevice): the same payload for APNS and APNS_SANDBOX. */
export const noticeMessage = (): string => {
  const apns = JSON.stringify(noticeApnsPayload());
  return JSON.stringify({ default: NOTICE_TITLE, APNS: apns, APNS_SANDBOX: apns });
};

export type PublishResult = "sent" | "disabled" | "failed";

/** A gone or disabled endpoint, read as userNotifier reads it. */
const isGoneEndpoint = (error: unknown): boolean => {
  const name = errorName(error);
  const message = error instanceof Error ? error.message : "";
  const code = (error as { Error?: { Code?: unknown } } | null)?.Error?.Code;
  return (
    (name === "InvalidParameterException" && message.includes("No endpoint found")) ||
    message.includes("No endpoint found for the target arn specified") ||
    name === "EndpointDisabledException" ||
    code === "EndpointDisabled" ||
    message.includes("Endpoint is disabled")
  );
};

interface PublishCounts {
  sent: number;
  disabled: number;
  failed: number;
  /** Error names only: an SNS error message can hold the endpoint ARN. */
  errorNames: Record<string, number>;
}

const emptyPublishCounts = (): PublishCounts => ({ sent: 0, disabled: 0, failed: 0, errorNames: {} });

const publishNotice = async (
  sns: SnsSend,
  targetArn: string,
  message: string,
  counts: PublishCounts,
): Promise<PublishResult> => {
  try {
    await sns.send(new PublishCommand({ TargetArn: targetArn, MessageStructure: "json", Message: message }));
    counts.sent += 1;
    return "sent";
  } catch (error) {
    const result = isGoneEndpoint(error) ? "disabled" : "failed";
    counts[result] += 1;
    if (result === "failed") counts.errorNames[errorName(error)] = (counts.errorNames[errorName(error)] ?? 0) + 1;
    return result;
  }
};

const makePacer = (now: () => number, sleep: (ms: number) => Promise<void>) => {
  let nextAt = 0;
  return async (): Promise<void> => {
    const wait = nextAt - now();
    if (wait > 0) await sleep(wait);
    nextAt = now() + USER_PACE_MS;
  };
};

// ─── Run ───────────────────────────────────────────────────────────────────────

export interface SendCounts {
  /** Markers set by this run. */
  claimed: number;
  /** Users at least one device of whom got the push. */
  usersSent: number;
  /** Users claimed whose devices all failed or were disabled; they keep the marker. */
  usersNotDelivered: number;
  /** Users whose claim's condition failed (a marker meanwhile, or no longer in the audience). */
  claimSkipped: number;
  /** Users not tried: the window closed, or the run stopped or was interrupted. */
  notReached: number;
  devices: PublishCounts;
  stopped: string | null;
}

/** The stop reason of a run interrupted by Ctrl-C or SIGTERM. */
export const INTERRUPTED = "interrupted";

export interface CanaryCounts {
  devices: number;
  sendable: number;
  notificationsOff: number;
  publish: PublishCounts;
}

export interface MarkerCounts {
  markers: number;
  /** By the user's resolvedState, else selfAttestedState, else "none". */
  byState: Record<string, number>;
  cleared: number;
  /** A marker gone meanwhile (the condition failed). */
  gone: number;
  notReached: number;
  stopped: string | null;
}

export interface NoticeResult {
  mode: Mode;
  refusal: string | null;
  plan?: Omit<AudiencePlan, "sendable">;
  send?: SendCounts;
  canary?: CanaryCounts;
  markers?: MarkerCounts;
  exitCode: 0 | 1 | 2;
}

export interface NoticeDeps {
  dynamo: DynamoDBClient;
  sns: SnsSend;
  config: NoticeConfig;
  options: CliOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** True once Ctrl-C or SIGTERM came (watchInterrupts): a writing run finishes the user in flight, then stops. */
  interrupted?: () => boolean;
}

interface Runtime {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  interrupted: () => boolean;
}

const pad = (value: string | number, width: number): string => String(value).padEnd(width);

const printPlan = (log: (line: string) => void, plan: Omit<AudiencePlan, "sendable">): void => {
  log(
    `${pad("group", 13)}${pad("state", 6)}${pad("candidates", 11)}${pad("alreadySent", 12)}${pad("sendable", 9)}` +
      `${pad("noDevice", 9)}notificationsOff`,
  );
  for (const cell of plan.cells) {
    log(
      `${pad(cell.group, 13)}${pad(cell.state, 6)}${pad(cell.candidates, 11)}${pad(cell.alreadySent, 12)}` +
        `${pad(cell.sendable, 9)}${pad(cell.noDevice, 9)}${cell.notificationsOff}`,
    );
  }
  const { totals } = plan;
  log(
    `District notice plan: candidates=${totals.candidates} alreadySent=${totals.alreadySent} ` +
      `sendable=${totals.sendable} noDevice=${totals.noDevice} notificationsOff=${totals.notificationsOff} ` +
      `markers=${totals.markers}`,
  );
};

const describeAudience = (audience: AudienceOptions): string =>
  [
    `verified in ${NEW_MAP_STATES.join(" ")}`,
    audience.missouriSince !== null
      ? `missouri verified since ${audience.missouriSince.slice(0, 10)}`
      : "missouri left out",
    audience.selfAttested ? `selfAttested in ${NEW_MAP_STATES.join(" ")}` : "selfAttested left out",
  ].join("; ");

const summaryText = (summary: object): string => `${JSON.stringify(summary, null, 2)}\n`;

const errorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : errorName(error);
};

/**
 * Creates the summary file, a new one, before anything is read or sent: a path that exists or cannot be written
 * refuses the run instead of failing after the pushes. Returns the refusal, or null.
 */
const startSummary = (path: string, mode: Mode, startedAt: string): string | null => {
  try {
    writeFileSync(path, summaryText({ mode, startedAt, status: "started" }), { flag: "wx" });
    return null;
  } catch (error) {
    const code = errorCode(error);
    return code === "EEXIST" ? `${path} exists; name a new summary file` : `cannot create ${path} (${code})`;
  }
};

/** Replaces the started summary with the counts. */
const finishSummary = (path: string | null, summary: object): void => {
  if (path) writeFileSync(path, summaryText(summary));
};

/** Takes back the summary of a run refused after it was created, so nothing is left written. */
const dropSummary = (path: string | null): void => {
  if (path) rmSync(path, { force: true });
};

const runSend = async (deps: NoticeDeps, plan: AudiencePlan, runtime: Runtime): Promise<SendCounts> => {
  const { now, log } = runtime;
  const { audience } = deps.options;
  const states = audienceStates(audience);
  const message = noticeMessage();
  const pace = makePacer(now, runtime.sleep);
  const counts: SendCounts = {
    claimed: 0,
    usersSent: 0,
    usersNotDelivered: 0,
    claimSkipped: 0,
    notReached: 0,
    devices: emptyPublishCounts(),
    stopped: null,
  };

  for (let index = 0; index < plan.sendable.length; index += 1) {
    const user = plan.sendable[index];
    await pace();
    const refusal = runtime.interrupted() ? INTERRUPTED : sendWindowRefusal(now(), states);
    if (refusal) {
      counts.stopped = refusal;
      counts.notReached = plan.sendable.length - index;
      break;
    }

    try {
      await deps.dynamo.send(
        new UpdateItemCommand(
          claimMarkerInput(deps.config.piiTableName, user, audience, new Date(now()).toISOString()),
        ),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        counts.claimSkipped += 1;
        continue;
      }
      counts.stopped = `claim failed: ${errorName(error)}`;
      counts.notReached = plan.sendable.length - index;
      break;
    }
    counts.claimed += 1;

    const results: PublishResult[] = [];
    for (const endpointArn of user.endpointArns) {
      results.push(await publishNotice(deps.sns, endpointArn, message, counts.devices));
    }
    if (results.includes("sent")) counts.usersSent += 1;
    else counts.usersNotDelivered += 1;
    if (results.includes("failed")) {
      counts.stopped = "a publish failed";
      counts.notReached = plan.sendable.length - index - 1;
      break;
    }
  }

  log(
    `District notice send: claimed=${counts.claimed} usersSent=${counts.usersSent} ` +
      `usersNotDelivered=${counts.usersNotDelivered} claimSkipped=${counts.claimSkipped} ` +
      `notReached=${counts.notReached} devicesSent=${counts.devices.sent} devicesDisabled=${counts.devices.disabled} ` +
      `devicesFailed=${counts.devices.failed} stopped=${counts.stopped ?? "no"}`,
  );
  for (const [name, count] of Object.entries(counts.devices.errorNames)) log(`Publish error ${name}: ${count}`);
  return counts;
};

const runCanary = async (deps: NoticeDeps, log: (line: string) => void): Promise<NoticeResult> => {
  if (!deps.config.canarySub) {
    log("Refused: set NOTICE_CANARY_SUB to your own account's sub (read -rs; it is never printed).");
    return { mode: "canary", refusal: "NOTICE_CANARY_SUB is not set", exitCode: 2 };
  }
  const deviceDao = new UserDeviceDao(deps.dynamo, {
    tableName: deps.config.deviceTableName,
    userIdAttribute: PII_PARTITION_KEY,
    deviceIdAttribute: DEVICE_SORT_KEY,
  });
  const devices = await deviceDao.getDevicesForUser(deps.config.canarySub);
  const targets = sendableDevices(devices);
  const canary: CanaryCounts = {
    devices: devices.length,
    sendable: targets.length,
    notificationsOff: devices.filter(hasEndpoint).length - targets.length,
    publish: emptyPublishCounts(),
  };
  const message = noticeMessage();
  for (const device of targets) await publishNotice(deps.sns, device.endpointArn, message, canary.publish);
  log(
    `District notice canary: devices=${canary.devices} sendable=${canary.sendable} ` +
      `notificationsOff=${canary.notificationsOff} sent=${canary.publish.sent} disabled=${canary.publish.disabled} ` +
      `failed=${canary.publish.failed}`,
  );
  for (const [name, count] of Object.entries(canary.publish.errorNames)) log(`Publish error ${name}: ${count}`);
  const delivered = canary.publish.sent > 0 && canary.publish.failed === 0;
  return { mode: "canary", refusal: null, canary, exitCode: delivered ? 0 : 1 };
};

const runMarkers = async (deps: NoticeDeps, startedAt: string, runtime: Runtime): Promise<NoticeResult> => {
  const { now, log } = runtime;
  const { mode, expectMarkers, summaryFile } = deps.options;
  const items = (await scanUserPii(deps.dynamo, deps.config.piiTableName)).filter(
    (item) => item[PII_PARTITION_KEY]?.S && item[MARKER_ATTRIBUTE] !== undefined,
  );
  const counts: MarkerCounts = {
    markers: items.length,
    byState: {},
    cleared: 0,
    gone: 0,
    notReached: 0,
    stopped: null,
  };
  for (const item of items) {
    const state = item.resolvedState?.S ?? item.selfAttestedState?.S ?? "none";
    counts.byState[state] = (counts.byState[state] ?? 0) + 1;
  }
  for (const [state, count] of Object.entries(counts.byState).sort(([left], [right]) => left.localeCompare(right))) {
    log(`${pad(state, 6)}${count}`);
  }
  log(`District notice markers: markers=${counts.markers}`);
  const finish = (status: string) =>
    finishSummary(summaryFile, {
      mode,
      startedAt,
      status,
      finishedAt: new Date(now()).toISOString(),
      markers: counts,
    });
  if (mode === "markers") {
    finish("finished");
    return { mode, refusal: null, markers: counts, exitCode: 0 };
  }

  if (counts.markers !== expectMarkers) {
    dropSummary(summaryFile);
    const refusal = `markers=${counts.markers}, not the expected ${expectMarkers}; count them again`;
    log(`Refused: ${refusal}. Nothing was written.`);
    return { mode, refusal, markers: counts, exitCode: 2 };
  }
  const pace = makePacer(now, runtime.sleep);
  let status = "failed";
  try {
    for (let index = 0; index < items.length; index += 1) {
      await pace();
      if (runtime.interrupted()) {
        counts.stopped = INTERRUPTED;
        counts.notReached = items.length - index;
        break;
      }
      try {
        await deps.dynamo.send(
          new UpdateItemCommand({
            TableName: deps.config.piiTableName,
            Key: { [PII_PARTITION_KEY]: { S: items[index][PII_PARTITION_KEY].S ?? "" } },
            UpdateExpression: "REMOVE #marker",
            ConditionExpression: "attribute_exists(#marker)",
            ExpressionAttributeNames: { "#marker": MARKER_ATTRIBUTE },
          }),
        );
        counts.cleared += 1;
      } catch (error) {
        if (isConditionFailure(error)) {
          counts.gone += 1;
          continue;
        }
        counts.stopped = `clear failed: ${errorName(error)}`;
        counts.notReached = items.length - index;
        break;
      }
    }
    status = "finished";
  } finally {
    finish(status);
  }
  log(
    `District notice markers cleared: cleared=${counts.cleared} gone=${counts.gone} notReached=${counts.notReached} ` +
      `stopped=${counts.stopped ?? "no"}`,
  );
  return { mode, refusal: null, markers: counts, exitCode: counts.stopped ? 1 : 0 };
};

export const runNotice = async (deps: NoticeDeps): Promise<NoticeResult> => {
  const runtime: Runtime = {
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    log: deps.log ?? ((line: string) => console.log(line)),
    interrupted: deps.interrupted ?? (() => false),
  };
  const { now, log } = runtime;
  const { mode, audience, summaryFile, expectSendable } = deps.options;

  if (mode === "canary") return runCanary(deps, log);
  const startedAt = new Date(now()).toISOString();
  if (mode === "apply") {
    const refusal = sendWindowRefusal(now(), audienceStates(audience));
    if (refusal) {
      log(`Refused: ${refusal}. Nothing was written.`);
      return { mode, refusal, exitCode: 2 };
    }
  }
  if (summaryFile) {
    const refusal = startSummary(summaryFile, mode, startedAt);
    if (refusal) {
      log(`Refused: ${refusal}. Nothing was written.`);
      return { mode, refusal, exitCode: 2 };
    }
  }
  if (mode === "markers" || mode === "clear-markers") return runMarkers(deps, startedAt, runtime);

  log(`District notice ${mode === "apply" ? "send" : "dry run"}, ${startedAt}`);
  log(`Audience: ${describeAudience(audience)}`);
  log(`Wording: "${NOTICE_TITLE}" / "${NOTICE_BODY}"`);
  const plan = await planAudience(deps.dynamo, deps.config, audience);
  const { sendable, ...counts } = plan;
  printPlan(log, counts);
  const summary = (status: string) => ({
    mode,
    startedAt,
    status,
    finishedAt: new Date(now()).toISOString(),
    audience: describeAudience(audience),
    wording: { title: NOTICE_TITLE, body: NOTICE_BODY },
    plan: counts,
  });

  if (mode === "dry-run") {
    finishSummary(summaryFile, summary("finished"));
    log(`To send: --apply --expect-sendable ${counts.totals.sendable} --summary-file <path>`);
    return { mode, refusal: null, plan: counts, exitCode: 0 };
  }

  if (sendable.length !== expectSendable) {
    dropSummary(summaryFile);
    const refusal = `sendable=${sendable.length}, not the expected ${expectSendable}; run the dry run again`;
    log(`Refused: ${refusal}. Nothing was written.`);
    return { mode, refusal, plan: counts, exitCode: 2 };
  }

  let send: SendCounts | undefined;
  try {
    send = await runSend(deps, plan, runtime);
  } finally {
    finishSummary(summaryFile, { ...summary(send ? "finished" : "failed"), send: send ?? null });
  }
  return { mode, refusal: null, plan: counts, send, exitCode: send.stopped === null ? 0 : 1 };
};

/**
 * A writing run (--apply, --clear-markers --apply) is not killed by the first Ctrl-C (or SIGTERM): the returned check
 * turns true, and the run finishes the user in flight, then stops and writes its summary. The second exits at once.
 * The other modes write nothing, so they keep the default and stop at once.
 */
export const watchInterrupts = (
  mode: Mode,
  proc: Pick<NodeJS.Process, "on" | "exit">,
  warn: (line: string) => void = (line) => console.error(line),
): (() => boolean) => {
  let interrupted = false;
  if (mode === "apply" || mode === "clear-markers") {
    const interrupt = (signal: NodeJS.Signals) => {
      if (interrupted) proc.exit(130);
      interrupted = true;
      warn(`${signal}: finishing the user in flight, then stopping (again to exit at once)`);
    };
    proc.on("SIGINT", interrupt);
    proc.on("SIGTERM", interrupt);
  }
  return () => interrupted;
};

/** ARNs and UUIDs (Cognito subs) taken out of an error before it is printed. */
export const redact = (text: string): string =>
  text
    .replace(/arn:aws[\w-]*:[^\s"',)]+/g, "<arn>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runNotice({
    dynamo: new DynamoDBClient({ region: config.region }),
    sns: new SNSClient({ region: config.region }),
    config,
    options,
    interrupted: watchInterrupts(options.mode, process),
  });
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`District notice failed: ${redact(`${errorName(error)}: ${(error as Error)?.message ?? ""}`)}`);
    process.exitCode = 1;
  });
}
