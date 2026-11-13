import { createHash } from "crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type Update,
} from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  ADDRESS_CHANGE_WINDOW_MS,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  RESTAMP_MESSAGE_DELAY_SECONDS,
  STREET_CLUSTER_FLAG_THRESHOLD,
  addressChangeLogFromPii,
  addressClaimKeys,
  adjustReleaseAfterCancellation,
  appendAddressChange,
  heldAddressClaimFromPii,
  incrementCounterItem,
  nextAddressChangeAllowedAt,
  putClaimItem,
  readClaimCounters,
  releaseClaimParts,
  releaseStaleUnitClaims,
  restampMessageBody,
  sameVerificationStamp,
  sendTransaction,
  streetClaimKey,
  stripUnitSuffix,
  unitClaimKey,
  unitFromAddressLines,
  verificationLimitsMode,
  verificationStampFromPii,
  type AddressClaimKeys,
  type HeldAddressClaim,
  type ReleaseOptions,
  type ReleaseRole,
  type TransactionPart,
  type VerificationLimitsMode,
  type VerificationStamp,
} from "../../shared/addressClaims";
import {
  normalizeAdultStatus,
  normalizeDeletionStatus,
  toForbiddenResponse,
  writeEligibilityBlockReason,
} from "../../shared/adultEligibility";
import { GEOCODER_VINTAGE_CURRENT, geocoderVintageFor } from "../../shared/districtLines";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const CENSUS_GEOCODER_BASE_URL =
  process.env.CENSUS_GEOCODER_BASE_URL ?? "https://geocoding.geo.census.gov/geocoder/geographies/address";
const CENSUS_GEOCODER_ONELINE_BASE_URL =
  process.env.CENSUS_GEOCODER_ONELINE_BASE_URL ?? CENSUS_GEOCODER_BASE_URL.replace(/\/address$/, "/onelineaddress");
const IP_LOOKUP_ENABLED = (process.env.IP_LOOKUP_ENABLED ?? "false").toLowerCase() === "true";
const IP_LOOKUP_URL_TEMPLATE = process.env.IP_LOOKUP_URL_TEMPLATE ?? "https://ipapi.co/{ip}/json/";
// The salt lives in Secrets Manager and is fetched once per container, by the ARN in HASH_SALT_SECRET_ARN.
// There is no HASH_SALT variable to fall back on (UA-15): the value never sits in the Lambda configuration,
// and a variable of that name set by mistake would not shadow the secret.
const HASH_SALT_SECRET_ARN = (process.env.HASH_SALT_SECRET_ARN ?? "").trim();
if (!HASH_SALT_SECRET_ARN) {
  throw new Error("HASH_SALT_SECRET_ARN must be configured for districtVerification.");
}

const db = new DynamoDBClient({});
const sqs = new SQSClient({});
const secretsManager = new SecretsManagerClient({});

let cachedHashSalt: string | null = null;

async function ensureHashSalt(): Promise<void> {
  if (cachedHashSalt) return;

  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: HASH_SALT_SECRET_ARN }));
  const value = (response.SecretString ?? "").trim();
  if (!value) {
    throw new Error("District verification hash salt secret is empty.");
  }
  cachedHashSalt = value;
}

/**
 * INT-03 (3A) and the re-stamp (X8) are configured per invocation, so a missing variable degrades
 * instead of failing the module:
 * - ADDRESS_CLAIMS_TABLE_NAME unset: no claims and no limits (the behaviour without address claims);
 * - VOTE_RESTAMP_QUEUE_URL unset: verification changes are not re-stamped onto existing votes;
 * - VERIFICATION_LIMITS_MODE: `enforce` caps and refuses; anything else is `watch`.
 */
interface LimitsConfig {
  claimsTableName?: string;
  restampQueueUrl?: string;
  mode: VerificationLimitsMode;
}

function limitsConfig(): LimitsConfig {
  return {
    claimsTableName: (process.env.ADDRESS_CLAIMS_TABLE_NAME ?? "").trim() || undefined,
    restampQueueUrl: (process.env.VOTE_RESTAMP_QUEUE_URL ?? "").trim() || undefined,
    mode: verificationLimitsMode(),
  };
}

const METRIC_ADDRESS_VERIFIED = "AddressVerified";
const METRIC_ADDRESS_LIMIT_REACHED = "AddressLimitReached";
const METRIC_REVERIFICATION_LIMIT_REACHED = "ReverificationLimitReached";
const METRIC_STREET_CLUSTER_FLAGGED = "StreetClusterFlagged";
const METRIC_IP_MISMATCH = "AddressVerifiedIpMismatch";
const METRIC_GEOCODER_VINTAGE_FALLBACK = "GeocoderVintageFallback";
const METRIC_RESTAMP_SKIPPED_DISTRICT_ONLY = "RestampSkippedDistrictOnly";

const ADDRESS_CAPPED_NEXT_STEP =
  "This address already has the most verified accounts we allow. Your district is saved; your votes count with all users but not as verified.";
const MANUAL_NEXT_STEP = "Add a full street address to verify district for representative delivery.";

/** The stamp a capped or self-attested account gives its votes. */
const UNVERIFIED_STAMP: VerificationStamp = { constituentVerified: false, verificationStatus: "self_attested" };

type Consistency = "match" | "mismatch" | "unknown";

type VerificationSnapshot = {
  verified: boolean;
  status?: string;
  method?: string;
  verifiedAt?: string;
  resolved?: {
    state: string;
    districtId: string;
  };
  signals?: {
    addressGeocoded: boolean;
    ipStateConsistency: Consistency;
    ipStateObserved?: string;
    districtClaimMatch?: boolean | null;
  };
  repsSignalEligible?: boolean;
  limitReason?: "address_limit";
  nextStep?: string;
};

type VerificationRequest = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  district?: string;
  claimedDistrict?: string;
};

type GeocodeResult = {
  state: string;
  districtCode: string;
  districtId: string;
  /** The geocoder's `matchedAddress`, when the match carries one. */
  matchedAddress?: string;
  /** The Congress the district comes from (CDSESSN, or the layer's number), and the vintage asked for. */
  congress?: string;
  vintage: string;
};

type GeocodeAttempt = {
  mode: "address_fields" | "oneline";
  candidateHash: string;
  matched: boolean;
};

function json(statusCode: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  try {
    if (!event?.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeState(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

function normalizeZip(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const plusFourMatch = value.match(/^(\d{5})-\d{4}$/);
  if (plusFourMatch) return plusFourMatch[1];
  return /^\d{5}$/.test(value) ? value : null;
}

function toCanonicalDistrictCode(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase();
  if (value === "AL") return "AL";
  if (!/^\d{1,2}$/.test(value)) return null;
  const code = value.padStart(2, "0");
  // "98" is the Census delegate code (DC and the territories). The app calls that seat AL.
  return code === "00" || code === "98" ? "AL" : code;
}

/** "DC-98" and "DC-AL" are the same seat. Anything that is not STATE-CODE comes back unchanged. */
function canonicalDistrictId(districtId: string): string {
  const parts = districtId.match(/^([A-Z]{2})-(.+)$/);
  const code = parts ? toCanonicalDistrictCode(parts[2]) : null;
  return parts && code ? `${parts[1]}-${code}` : districtId;
}

/** sameVerificationStamp, with the district compared in canonical form (a stored "DC-98" equals "DC-AL"). */
function sameStamp(a: VerificationStamp, b: VerificationStamp): boolean {
  const canonical = (stamp: VerificationStamp): VerificationStamp =>
    stamp.resolvedDistrict ? { ...stamp, resolvedDistrict: canonicalDistrictId(stamp.resolvedDistrict) } : stamp;
  return sameVerificationStamp(canonical(a), canonical(b));
}

/** Both stamps have a district, and only the district differs: same verified status and state. */
function onlyDistrictDiffers(previous: VerificationStamp, next: VerificationStamp): boolean {
  if (!previous.resolvedDistrict || !next.resolvedDistrict) return false;
  return sameStamp({ ...previous, resolvedDistrict: next.resolvedDistrict }, next) && !sameStamp(previous, next);
}

/**
 * The lookup is on lines newer than the 119th Congress's. On the 119th lines a district change is a
 * correction (a claim stored on the 120th lines or Missouri's unused 2025 map), so it still re-stamps.
 */
function onLinesAfter119th(geocode: GeocodeResult): boolean {
  return Number(geocode.congress) > 119;
}

function normalizeClaimedDistrict(state: string, raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase().replace(/\s+/g, "");

  const full = value.match(/^([A-Z]{2})-?(AL|\d{1,2})$/);
  if (full) {
    const claimState = full[1];
    const code = toCanonicalDistrictCode(full[2]);
    if (!code) return null;
    return `${claimState}-${code}`;
  }

  const localCode = toCanonicalDistrictCode(value);
  if (!localCode) return null;
  return `${state}-${localCode}`;
}

function toHash(value: string): string {
  if (!cachedHashSalt) {
    throw new Error("Hash salt has not been loaded; call ensureHashSalt() before hashing.");
  }
  return createHash("sha256").update(`${cachedHashSalt}:${value}`).digest("hex");
}

function getUserId(event: APIGatewayProxyEvent): string | null {
  const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;
  return claims?.sub ?? null;
}

// API Gateway sets identity.sourceIp from the connection. X-Forwarded-For and
// X-App-IP-State are client-controlled, so neither is read. Nor is
// CloudFront-Viewer-Country-Region (INT-02): it never reaches this
// edge-optimized API, and a client could send it.
function getSourceIp(event: APIGatewayProxyEvent): string | null {
  const direct = event?.requestContext?.identity?.sourceIp;
  return typeof direct === "string" && direct.trim().length > 0 ? direct.trim() : null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "BillBoardDistrictVerification/1.0" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** The IP's state from the lookup provider, only when IP_LOOKUP_ENABLED (off in production, Q2). */
async function lookupIpStateFromProvider(ip: string): Promise<string | null> {
  if (!IP_LOOKUP_ENABLED) return null;

  const endpoint = IP_LOOKUP_URL_TEMPLATE.replace("{ip}", encodeURIComponent(ip));

  try {
    const res = await fetchWithTimeout(endpoint, 2500);
    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, unknown>;
    const regionCode = body.region_code ?? body.regionCode ?? body.state_code ?? body.stateCode;

    return normalizeState(regionCode);
  } catch {
    return null;
  }
}

function normalizedLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function buildStreetCandidates(line1: string, line2?: string): string[] {
  const unique = new Set<string>();

  const add = (value?: string) => {
    if (!value) return;
    const normalized = normalizedLine(value);
    if (normalized.length > 0) unique.add(normalized);
  };

  const primary = normalizedLine(line1);
  const unitLine = normalizedLine(line2 ?? "");

  add(primary);

  if (unitLine) {
    add(`${primary} ${unitLine}`);
    add(`${primary}, ${unitLine}`);
  }

  const strippedPrimary = stripUnitSuffix(primary);
  if (strippedPrimary !== primary) {
    add(strippedPrimary);
    if (unitLine) add(`${strippedPrimary} ${unitLine}`);
  }

  if (unitLine) {
    const strippedCombined = stripUnitSuffix(`${primary} ${unitLine}`);
    add(strippedCombined);
  }

  return Array.from(unique);
}

type CongressionalLayer = { congress: number; record: Record<string, unknown> };

/** The first record of the highest-numbered "<n>th Congressional Districts" layer that has one. */
function findCongressionalLayer(geographies: Record<string, unknown> | undefined): CongressionalLayer | null {
  if (!geographies || typeof geographies !== "object") return null;

  let best: CongressionalLayer | null = null;
  for (const [key, value] of Object.entries(geographies)) {
    const named = key.match(/^(\d+)(st|nd|rd|th) Congressional Districts$/i);
    const record = Array.isArray(value) ? value[0] : undefined;
    if (!named || !record || typeof record !== "object") continue;
    const congress = Number(named[1]);
    if (!best || congress > best.congress) best = { congress, record: record as Record<string, unknown> };
  }
  return best;
}

/** The district in a layer's record: the highest CDnnn field, else the GEOID's last two digits, else BASENAME. */
function districtCodeOf(record: Record<string, unknown>): string | null {
  const present = (value: unknown): value is string | number => value != null && String(value).trim() !== "";

  const cdFields = Object.keys(record)
    .map((key) => ({ key, congress: Number(key.match(/^CD(\d{3})(FP)?$/i)?.[1]) }))
    .filter(({ key, congress }) => !Number.isNaN(congress) && present(record[key]))
    .sort((a, b) => b.congress - a.congress);
  if (cdFields.length > 0) return String(record[cdFields[0].key]);

  const geoid = String(record.GEOID ?? "").trim();
  if (/^\d{4}$/.test(geoid)) return geoid.slice(2);

  const baseName = String(record.BASENAME ?? "").trim();
  if (/^\d{1,2}$/.test(baseName)) return baseName;
  return /at large/i.test(baseName) ? "AL" : null;
}

function matchedAddressOf(match: unknown): string | undefined {
  const value = (match as { matchedAddress?: unknown } | null | undefined)?.matchedAddress;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function resolveDistrictFromAddress(address: {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}): Promise<{ result: GeocodeResult | null; attempts: GeocodeAttempt[] }> {
  const attempts: GeocodeAttempt[] = [];
  const streets = buildStreetCandidates(address.line1, address.line2);

  for (const street of streets) {
    const match = await resolveDistrictFromStreet({
      street,
      city: address.city,
      state: address.state,
      zip: address.zip,
    });
    attempts.push({
      mode: "address_fields",
      candidateHash: toHash(`${street}|${address.city}|${address.state}|${address.zip}`),
      matched: Boolean(match),
    });
    if (match) return { result: match, attempts };
  }

  // Fallback to Census one-line endpoint; this can resolve addresses that do not
  // match well via split field parameters.
  const onelineInput = [address.line1, address.line2, address.city, address.state, address.zip]
    .filter((value) => value && String(value).trim().length > 0)
    .join(", ");
  const onelineMatch = await resolveDistrictFromOneLineAddress(onelineInput, address.state);
  attempts.push({
    mode: "oneline",
    candidateHash: toHash(onelineInput),
    matched: Boolean(onelineMatch),
  });

  return { result: onelineMatch, attempts };
}

/** The parts of a Census geocoder response read here. */
type GeocoderResponse = {
  result?: {
    addressMatches?: Array<{ geographies?: Record<string, unknown>; addressComponents?: { state?: string } }>;
  };
};

type GeocoderAnswer = {
  firstMatch: { geographies?: unknown; addressComponents?: { state?: string } } | undefined;
  layer: CongressionalLayer | null;
  vintage: string;
};

async function requestGeocoder(url: URL, vintage: string, failure: string): Promise<GeocoderAnswer> {
  const res = await fetchWithTimeout(url.toString(), 5000);
  if (!res.ok) {
    // A 4xx that names the vintage or benchmark means the geocoder no longer serves it.
    const text = typeof res.text === "function" ? await res.text().catch(() => "") : "";
    const vintageRejected = res.status >= 400 && res.status < 500 && /vintage|benchmark/i.test(text);
    throw Object.assign(new Error(`${failure} failed with status ${res.status}`), { vintageRejected });
  }

  const data = (await res.json()) as GeocoderResponse;
  const firstMatch = data?.result?.addressMatches?.[0];
  return { firstMatch, layer: findCongressionalLayer(firstMatch?.geographies), vintage };
}

/**
 * Asks the geocoder for the vintage districtLines picks for this state. When the geocoder rejects that vintage,
 * or answers a match with no congressional layer, and it is not Current_Current, asks once more on
 * Current_Current. Any other failure is thrown as before.
 */
async function askGeocoder(makeUrl: (vintage: string) => URL, state: string, failure: string): Promise<GeocoderAnswer> {
  const vintage = geocoderVintageFor(state, Date.now());
  let first: GeocoderAnswer | undefined;
  try {
    first = await requestGeocoder(makeUrl(vintage), vintage, failure);
  } catch (error) {
    if (vintage === GEOCODER_VINTAGE_CURRENT || !(error as { vintageRejected?: boolean }).vintageRejected) throw error;
  }
  if (first && (vintage === GEOCODER_VINTAGE_CURRENT || !first.firstMatch || first.layer)) return first;

  logger.warn("Census geocoder gave no usable answer for the vintage; retrying with the current vintage", {
    state,
    vintage,
    fallbackVintage: GEOCODER_VINTAGE_CURRENT,
  });
  emitIntegrityMetric(METRIC_GEOCODER_VINTAGE_FALLBACK, {
    state,
    vintage,
    fallbackVintage: GEOCODER_VINTAGE_CURRENT,
  });
  return requestGeocoder(makeUrl(GEOCODER_VINTAGE_CURRENT), GEOCODER_VINTAGE_CURRENT, failure);
}

function geocodeResultOf(answer: GeocoderAnswer, state: string | null): GeocodeResult | null {
  const { firstMatch, layer, vintage } = answer;
  const rawDistrictCode = layer ? districtCodeOf(layer.record) : null;
  const districtCode = toCanonicalDistrictCode(rawDistrictCode);
  if (!firstMatch || !state || !districtCode) return null;

  const session = layer?.record.CDSESSN;
  return {
    state,
    districtCode,
    districtId: `${state}-${districtCode}`,
    matchedAddress: matchedAddressOf(firstMatch),
    congress: session != null && String(session).trim() !== "" ? String(session).trim() : String(layer?.congress),
    vintage,
  };
}

async function resolveDistrictFromStreet(address: {
  street: string;
  city: string;
  state: string;
  zip: string;
}): Promise<GeocodeResult | null> {
  const answer = await askGeocoder(
    (vintage) => {
      const url = new URL(CENSUS_GEOCODER_BASE_URL);
      url.searchParams.set("street", address.street);
      url.searchParams.set("city", address.city);
      url.searchParams.set("state", address.state);
      url.searchParams.set("zip", address.zip);
      url.searchParams.set("benchmark", "Public_AR_Current");
      url.searchParams.set("vintage", vintage);
      url.searchParams.set("format", "json");
      return url;
    },
    address.state,
    "Census geocoder request",
  );
  return geocodeResultOf(answer, normalizeState(answer.firstMatch?.addressComponents?.state) ?? address.state);
}

async function resolveDistrictFromOneLineAddress(address: string, requestState: string): Promise<GeocodeResult | null> {
  const answer = await askGeocoder(
    (vintage) => {
      const url = new URL(CENSUS_GEOCODER_ONELINE_BASE_URL);
      url.searchParams.set("address", address);
      url.searchParams.set("benchmark", "Public_AR_Current");
      url.searchParams.set("vintage", vintage);
      url.searchParams.set("format", "json");
      return url;
    },
    requestState,
    "Census one-line geocoder request",
  );
  return geocodeResultOf(answer, normalizeState(answer.firstMatch?.addressComponents?.state));
}

function buildSnapshot(item: Record<string, AttributeValue> | undefined): VerificationSnapshot {
  if (!item) return { verified: false };

  const method = item.verificationMethod?.S;
  const explicitVerified = item.constituentVerified?.BOOL;
  const verified = explicitVerified === undefined ? method === "address_geocode" : Boolean(explicitVerified);
  const resolvedState = item.resolvedState?.S ?? (verified ? undefined : item.selfAttestedState?.S);
  const resolvedDistrict = item.resolvedDistrict?.S ?? (verified ? undefined : item.selfAttestedDistrict?.S);
  const ipStateConsistency = (item.ipStateConsistency?.S as Consistency | undefined) ?? "unknown";
  const capped = method === "address_capped";
  // The contract allows limitReason only beside verified: false.
  const limitReason = !verified && item.verificationLimitReason?.S === "address_limit" ? "address_limit" : undefined;

  return {
    verified,
    status: item.verificationStatus?.S,
    method,
    verifiedAt: item.verifiedAt?.S,
    resolved:
      resolvedState && resolvedDistrict
        ? {
            state: resolvedState,
            districtId: resolvedDistrict,
          }
        : undefined,
    signals: {
      addressGeocoded: method === "address_geocode" || capped,
      ipStateConsistency,
      ipStateObserved: item.ipStateObserved?.S,
      districtClaimMatch: item.districtClaimMatch?.BOOL === undefined ? null : Boolean(item.districtClaimMatch.BOOL),
    },
    repsSignalEligible: verified,
    limitReason,
    nextStep: verified ? undefined : capped || limitReason ? ADDRESS_CAPPED_NEXT_STEP : MANUAL_NEXT_STEP,
  };
}

async function handleGet(userId: string) {
  const result = await db.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { [PARTITION_KEY]: { S: userId } },
      ProjectionExpression:
        "verificationStatus, verificationMethod, constituentVerified, verifiedAt, resolvedState, resolvedDistrict, selfAttestedState, selfAttestedDistrict, ipStateConsistency, ipStateObserved, districtClaimMatch, verificationLimitReason",
    }),
  );

  return json(200, buildSnapshot(result.Item));
}

// ─── Caller state ─────────────────────────────────────────────────────────────

/** The caller's UserPII state a POST needs: eligibility, the vote stamp, the claim and the change log. */
type CallerState = {
  eligibility: {
    adultStatus: ReturnType<typeof normalizeAdultStatus>;
    deletionStatus: ReturnType<typeof normalizeDeletionStatus>;
  };
  stamp: VerificationStamp;
  heldClaim: HeldAddressClaim | null;
  addressChangeLog: string[];
};

/**
 * One strongly consistent read of the caller's UserPII row. Fails closed like loadUserEligibility:
 * an error is thrown (500) rather than read as an eligible user with no claim.
 */
async function readCallerState(userId: string): Promise<CallerState> {
  const result = await db.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { [PARTITION_KEY]: { S: userId } },
      ConsistentRead: true,
      ProjectionExpression:
        "adultStatus, deletionStatus, constituentVerified, verificationStatus, resolvedState, resolvedDistrict, verifiedAddressKey, verifiedStreetKey, addressChangeLog",
    }),
  );
  const item = result.Item;
  return {
    eligibility: {
      adultStatus: normalizeAdultStatus(item?.adultStatus?.S),
      deletionStatus: normalizeDeletionStatus(item?.deletionStatus?.S),
    },
    stamp: verificationStampFromPii(item),
    heldClaim: heldAddressClaimFromPii(item),
    addressChangeLog: addressChangeLogFromPii(item),
  };
}

// ─── UserPII writes ───────────────────────────────────────────────────────────

/** A UserPII update under construction: SET clauses, REMOVE names and the values they use. */
type PiiUpdate = { set: string[]; remove: string[]; values: Record<string, AttributeValue> };

type PiiCondition = { expression: string; values?: Record<string, AttributeValue> };

/**
 * Part of every UserPII write: the account is not being deleted. The eligibility check reads the row
 * once, before the geocode; a DELETE /account-data that starts after it sets deletionStatus first, so
 * this verification then neither writes onto the account's tombstone nor commits a claim and its
 * counters that the deletion already looked for (X5). As in voteDailyCap.
 */
const NOT_DELETING_CONDITION =
  "(attribute_not_exists(deletionStatus) OR (deletionStatus <> :deletionInProgress AND deletionStatus <> :deletionCompleted))";
const NOT_DELETING_VALUES: Record<string, AttributeValue> = {
  ":deletionInProgress": { S: "in_progress" },
  ":deletionCompleted": { S: "completed" },
};

function piiUpdateInput(userId: string, update: PiiUpdate, condition?: PiiCondition): Update {
  return {
    TableName: TABLE_NAME,
    Key: { [PARTITION_KEY]: { S: userId } },
    UpdateExpression: `SET ${update.set.join(", ")}${update.remove.length ? ` REMOVE ${update.remove.join(", ")}` : ""}`,
    ConditionExpression: condition ? `(${condition.expression}) AND ${NOT_DELETING_CONDITION}` : NOT_DELETING_CONDITION,
    ExpressionAttributeValues: { ...update.values, ...(condition?.values ?? {}), ...NOT_DELETING_VALUES },
  };
}

/** A write refused because the account became ineligible (a deletion started) after the first read: 403. */
class WriteBlockedError extends Error {
  constructor(readonly reason: NonNullable<ReturnType<typeof writeEligibilityBlockReason>>) {
    super(`districtVerification: the account became ineligible (${reason})`);
    this.name = "WriteBlockedError";
  }
}

/** After a lost conditional write: stop with 403 when the re-read row shows a deletion. */
function throwIfWriteBlocked(caller: CallerState): void {
  const reason = writeEligibilityBlockReason(caller.eligibility);
  if (reason) throw new WriteBlockedError(reason);
}

/** The write lands only if the account still holds the claim this request read (C2 3.3.3 step 8). */
function heldClaimCondition(held: HeldAddressClaim | null): PiiCondition {
  return held
    ? { expression: "verifiedAddressKey = :prevAddressKey", values: { ":prevAddressKey": { S: held.unitKey } } }
    : { expression: "attribute_not_exists(verifiedAddressKey)" };
}

type WriteOutcome = "ok" | "pii_conflict";

async function writePii(update: Update): Promise<WriteOutcome> {
  try {
    await db.send(new UpdateItemCommand(update));
    return "ok";
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") return "pii_conflict";
    throw error;
  }
}

/**
 * Writes the UserPII update and, when the account holds a claim, releases it in the same
 * transaction (capped and manual writes). A claim row that is already gone, or a counter already
 * at 0, is left out on the next attempt instead of failing the request.
 */
async function writeReleasingClaim(
  tableName: string,
  userId: string,
  held: HeldAddressClaim | null,
  update: Update,
): Promise<WriteOutcome> {
  let release: ReleaseOptions | null = held ? { skipStreetCounter: !held.streetKey } : null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!held || !release) return writePii(update);
    const parts: TransactionPart<ReleaseRole | "pii">[] = [
      ...releaseClaimParts(tableName, userId, held, release),
      { role: "pii", item: { Update: update } },
    ];
    const result = await sendTransaction(db, parts);
    if (result.ok) return "ok";
    if (result.failed.has("pii")) return "pii_conflict";
    if (result.failed.has("prevClaim")) {
      logger.warn("The account's recorded address claim row is missing; writing without releasing it");
    }
    release = adjustReleaseAfterCancellation(release, result.failed);
  }
  throw new Error("districtVerification: releasing the address claim did not settle");
}

type ClaimRole = "unitCounter" | "newClaim" | "streetCounter" | ReleaseRole | "pii";
type ClaimOutcome = "claimed" | "unit_full" | "pii_conflict";

/**
 * C2 3.3.3 step 6 in one transaction: count and claim the new unit (in enforce only while it has
 * fewer than 4 claims), count the street, release the previous claim, and write the UserPII row.
 * A move between units of one street address leaves the street counter unchanged.
 */
async function claimAddress(input: {
  tableName: string;
  userId: string;
  keys: AddressClaimKeys;
  held: HeldAddressClaim | null;
  mode: VerificationLimitsMode;
  nowIso: string;
  update: Update;
}): Promise<ClaimOutcome> {
  const { tableName, userId, keys, held, mode, nowIso, update } = input;
  // True when the account already holds a claim row on this unit that its UserPII row does not
  // record (a hand edit or a partial restore): that row is already counted, so it is kept.
  let adoptExistingClaim = false;
  let release: ReleaseOptions | null = held ? { skipStreetCounter: !held.streetKey } : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sameStreet =
      !adoptExistingClaim &&
      held !== null &&
      release !== null &&
      !release.skipStreetCounter &&
      held.streetKey === keys.streetKey;
    const parts: TransactionPart<ClaimRole>[] = [];
    if (!adoptExistingClaim) {
      const cap = mode === "enforce" ? MAX_VERIFIED_ACCOUNTS_PER_ADDRESS : undefined;
      parts.push({ role: "unitCounter", item: incrementCounterItem(tableName, unitClaimKey(keys.unitKey), cap) });
      parts.push({ role: "newClaim", item: putClaimItem(tableName, keys.unitKey, userId, nowIso) });
      if (!sameStreet) {
        parts.push({ role: "streetCounter", item: incrementCounterItem(tableName, streetClaimKey(keys.streetKey)) });
      }
    }
    if (held && release) {
      parts.push(
        ...releaseClaimParts(tableName, userId, held, sameStreet ? { ...release, skipStreetCounter: true } : release),
      );
    }
    parts.push({ role: "pii", item: { Update: update } });

    const result = await sendTransaction(db, parts);
    if (result.ok) return "claimed";
    const { failed } = result;
    if (failed.has("pii")) return "pii_conflict";

    let adjusted = false;
    if (failed.has("newClaim") && !adoptExistingClaim) {
      logger.warn("The account already holds a claim on this address that its profile does not record; keeping it");
      adoptExistingClaim = true;
      adjusted = true;
    }
    if (
      held &&
      release &&
      (failed.has("prevClaim") || failed.has("prevUnitCounter") || failed.has("prevStreetCounter"))
    ) {
      if (failed.has("prevClaim")) {
        logger.warn("The account's recorded address claim row is missing; verifying without releasing it");
      }
      release = adjustReleaseAfterCancellation(release, failed);
      adjusted = true;
    }
    if (adjusted) continue;
    if (failed.has("unitCounter")) return "unit_full";
    throw new Error(`districtVerification: unexpected claim condition failure (${[...failed].join(", ")})`);
  }
  throw new Error("districtVerification: the address claim did not settle");
}

// ─── Address mode ─────────────────────────────────────────────────────────────

interface AddressVerificationInput {
  userId: string;
  caller: CallerState;
  geocode: GeocodeResult;
  /** The matched address the claim keys hash (the geocoder's, else rebuilt from the request). */
  matchedAddress: string;
  unit: string;
  claimedDistrict: string | null;
  districtClaimMatch: boolean | null;
  ip: string | null;
  ipStateObserved: string | null;
  ipStateConsistency: Consistency;
  nowIso: string;
}

/** claimedDistrict, the observed IP state and the IP hash, set or removed as without address claims. */
function addSignalFields(update: PiiUpdate, input: AddressVerificationInput): PiiUpdate {
  if (input.claimedDistrict) {
    update.set.push("claimedDistrict = :claimedDistrict", "districtClaimMatch = :districtClaimMatch");
    update.values[":claimedDistrict"] = { S: input.claimedDistrict };
    update.values[":districtClaimMatch"] = { BOOL: Boolean(input.districtClaimMatch) };
  } else {
    update.remove.push("claimedDistrict", "districtClaimMatch");
  }
  if (input.ipStateObserved) {
    update.set.push("ipStateObserved = :ipStateObserved");
    update.values[":ipStateObserved"] = { S: input.ipStateObserved };
  } else {
    update.remove.push("ipStateObserved");
  }
  if (input.ip) {
    update.set.push("ipHash = :ipHash");
    update.values[":ipHash"] = { S: toHash(input.ip) };
  } else {
    update.remove.push("ipHash");
  }
  return update;
}

/** The verified fields exactly as without address claims, plus the removal of a held-back limit reason. */
function verifiedPiiUpdate(input: AddressVerificationInput): PiiUpdate {
  const update: PiiUpdate = {
    set: [
      "verificationStatus = :verificationStatus",
      "verificationMethod = :verificationMethod",
      "constituentVerified = :constituentVerified",
      "verifiedAt = :verifiedAt",
      "resolvedState = :resolvedState",
      "resolvedDistrict = :resolvedDistrict",
      "ipStateConsistency = :ipStateConsistency",
      "updatedAt = :updatedAt",
    ],
    remove: ["selfAttestedState", "selfAttestedDistrict", "verificationLimitReason"],
    values: {
      ":verificationStatus": { S: "likely_constituent" },
      ":verificationMethod": { S: "address_geocode" },
      ":constituentVerified": { BOOL: true },
      ":verifiedAt": { S: input.nowIso },
      ":resolvedState": { S: input.geocode.state },
      ":resolvedDistrict": { S: input.geocode.districtId },
      ":ipStateConsistency": { S: input.ipStateConsistency },
      ":updatedAt": { S: input.nowIso },
    },
  };
  return addSignalFields(update, input);
}

/** The verified fields plus the new claim and the change log (step 6). */
function claimingPiiUpdate(input: AddressVerificationInput, keys: AddressClaimKeys): PiiUpdate {
  const update = verifiedPiiUpdate(input);
  update.set.push(
    "verifiedAddressKey = :verifiedAddressKey",
    "verifiedStreetKey = :verifiedStreetKey",
    "addressChangeLog = :addressChangeLog",
  );
  update.values[":verifiedAddressKey"] = { S: keys.unitKey };
  update.values[":verifiedStreetKey"] = { S: keys.streetKey };
  update.values[":addressChangeLog"] = {
    L: appendAddressChange(input.caller.addressChangeLog, input.nowIso).map((entry) => ({ S: entry })),
  };
  return update;
}

/** The capped state (step 7): self-attested at the geocoded district, no claim, not counted. */
function cappedPiiUpdate(input: AddressVerificationInput): PiiUpdate {
  const update: PiiUpdate = {
    set: [
      "verificationStatus = :verificationStatus",
      "verificationMethod = :verificationMethod",
      "constituentVerified = :constituentVerified",
      "verifiedAt = :verifiedAt",
      "selfAttestedState = :selfAttestedState",
      "selfAttestedDistrict = :selfAttestedDistrict",
      "verificationLimitReason = :verificationLimitReason",
      "ipStateConsistency = :ipStateConsistency",
      "updatedAt = :updatedAt",
    ],
    remove: ["resolvedState", "resolvedDistrict", "verifiedAddressKey", "verifiedStreetKey"],
    values: {
      ":verificationStatus": { S: "self_attested" },
      ":verificationMethod": { S: "address_capped" },
      ":constituentVerified": { BOOL: false },
      ":verifiedAt": { S: input.nowIso },
      ":selfAttestedState": { S: input.geocode.state },
      ":selfAttestedDistrict": { S: input.geocode.districtId },
      ":verificationLimitReason": { S: "address_limit" },
      ":ipStateConsistency": { S: input.ipStateConsistency },
      ":updatedAt": { S: input.nowIso },
    },
  };
  return addSignalFields(update, input);
}

function verifiedBody(input: AddressVerificationInput): Record<string, unknown> {
  return {
    verified: true,
    status: "likely_constituent",
    method: "address_geocode",
    verifiedAt: input.nowIso,
    resolved: {
      state: input.geocode.state,
      districtId: input.geocode.districtId,
    },
    signals: {
      addressGeocoded: true,
      ipStateConsistency: input.ipStateConsistency,
      ipStateObserved: input.ipStateObserved,
      districtClaimMatch: input.districtClaimMatch,
    },
    repsSignalEligible: true,
  };
}

function cappedBody(input: AddressVerificationInput): Record<string, unknown> {
  return {
    verified: false,
    status: "self_attested",
    method: "address_capped",
    verifiedAt: input.nowIso,
    resolved: {
      state: input.geocode.state,
      districtId: input.geocode.districtId,
    },
    signals: {
      addressGeocoded: true,
      ipStateConsistency: input.ipStateConsistency,
      ipStateObserved: input.ipStateObserved,
      districtClaimMatch: input.districtClaimMatch,
    },
    repsSignalEligible: false,
    limitReason: "address_limit",
    nextStep: ADDRESS_CAPPED_NEXT_STEP,
  };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const formatUtcDate = (ms: number): string => {
  const date = new Date(ms);
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 429 VERIFICATION_RATE_LIMITED (enforce), with Retry-After until the oldest change ages out. */
function reverificationLimitedResponse(allowedAtMs: number, nowMs: number): APIGatewayProxyResult {
  const retryAfterSeconds = Math.max(1, Math.ceil((allowedAtMs - nowMs) / 1000));
  return json(
    429,
    {
      error: "VERIFICATION_RATE_LIMITED",
      message: `You can verify a new address ${MAX_ADDRESS_CHANGES_PER_WINDOW} times in ${ADDRESS_CHANGE_WINDOW_MS / DAY_MS} days. Try again after ${formatUtcDate(allowedAtMs)}.`,
    },
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function emitIntegrityMetric(name: string, properties: Record<string, unknown>): void {
  emitEmbeddedMetric(ACCOUNT_INTEGRITY_METRIC_NAMESPACE, name, 1, { properties });
}

/**
 * Sends `{userId}` to RestampUserVotesQueue (delayed 10 s) so the account's stored votes take its
 * new verification stamp (X8). Called before any write: a failed send throws, the request returns
 * 500 and nothing was written, so the client's retry is clean.
 */
async function enqueueRestamp(userId: string, queueUrl: string | undefined): Promise<void> {
  if (!queueUrl) {
    logger.warn("VOTE_RESTAMP_QUEUE_URL is not set; existing votes keep their verification stamp");
    return;
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: restampMessageBody(userId),
      DelaySeconds: RESTAMP_MESSAGE_DELAY_SECONDS,
    }),
  );
}

/** Emits StreetClusterFlagged and (watch) AddressLimitReached from the counters after a new claim. */
async function reportNewClaim(tableName: string, keys: AddressClaimKeys, mode: VerificationLimitsMode): Promise<void> {
  emitIntegrityMetric(METRIC_ADDRESS_VERIFIED, { verificationLimitsMode: mode });
  try {
    const unitKey = unitClaimKey(keys.unitKey);
    const streetKey = streetClaimKey(keys.streetKey);
    const counts = await readClaimCounters(db, tableName, [unitKey, streetKey], { consistentRead: true });
    const unitCount = counts.get(unitKey) ?? 0;
    const streetCount = counts.get(streetKey) ?? 0;
    if (streetCount > STREET_CLUSTER_FLAG_THRESHOLD) {
      emitIntegrityMetric(METRIC_STREET_CLUSTER_FLAGGED, { verificationLimitsMode: mode, streetCount });
    }
    if (mode === "watch" && unitCount > MAX_VERIFIED_ACCOUNTS_PER_ADDRESS) {
      emitIntegrityMetric(METRIC_ADDRESS_LIMIT_REACHED, {
        verificationLimitsMode: mode,
        outcome: "would_cap",
        unitCount,
      });
    }
  } catch (error) {
    logger.warn("Could not read the address claim counters after a verification", { error });
  }
}

/** The IP flag (INT-02, never a downgrade) and the outcome line, after an address-mode write. */
function finishAddressWrite(
  input: AddressVerificationInput,
  mode: VerificationLimitsMode | "off",
  outcome: string,
): void {
  if (input.ipStateConsistency === "mismatch") {
    emitIntegrityMetric(METRIC_IP_MISMATCH, { verificationLimitsMode: mode, outcome });
  }
  logger.info("District verification stored", {
    requestType: "address_geocode",
    verificationLimitsMode: mode,
    outcome,
    ipStateConsistency: input.ipStateConsistency,
    congress: input.geocode.congress,
    vintage: input.geocode.vintage,
  });
}

/** Address mode with ADDRESS_CLAIMS_TABLE_NAME unset: the write without address claims, plus the re-stamp. */
async function verifyAddressWithoutLimits(input: AddressVerificationInput, config: LimitsConfig) {
  const verifiedStamp = verifiedStampFor(input.geocode);
  if (!sameStamp(input.caller.stamp, verifiedStamp)) {
    await enqueueRestamp(input.userId, config.restampQueueUrl);
  }
  if ((await writePii(piiUpdateInput(input.userId, verifiedPiiUpdate(input)))) === "pii_conflict") {
    throwIfWriteBlocked(await readCallerState(input.userId));
    throw new Error("districtVerification: the verification write did not settle");
  }
  emitIntegrityMetric(METRIC_ADDRESS_VERIFIED, { verificationLimitsMode: "off" });
  finishAddressWrite(input, "off", "verified");
  return json(200, verifiedBody(input));
}

function verifiedStampFor(geocode: GeocodeResult): VerificationStamp {
  return {
    constituentVerified: true,
    verificationStatus: "likely_constituent",
    resolvedState: geocode.state,
    resolvedDistrict: geocode.districtId,
  };
}

/**
 * C2 3.3.3 steps 2 to 8 (the caller's row was read before the geocode). In watch, claims and
 * counters are written exactly as in enforce, but nothing is capped or refused: only the metrics.
 */
async function verifyAddressWithLimits(
  initial: AddressVerificationInput,
  config: LimitsConfig & { claimsTableName: string },
): Promise<APIGatewayProxyResult> {
  const { userId, nowIso } = initial;
  const { claimsTableName: tableName, mode } = config;
  const nowMs = Date.parse(nowIso);
  const keys = addressClaimKeys(initial.matchedAddress, initial.unit, toHash);
  const verifiedStamp = verifiedStampFor(initial.geocode);

  let input = initial;
  let rereads = 0;
  let restampQueued = false;
  let reverificationReported = false;
  let selfHealed = false;

  // Step 8: a write that lost to a concurrent verification by the same account re-reads the row
  // and runs steps 3 to 6 once more; a second loss is a 500.
  const reread = async (): Promise<void> => {
    if (rereads >= 1) throw new Error("districtVerification: a concurrent verification of this account did not settle");
    rereads += 1;
    input = { ...input, caller: await readCallerState(userId) };
    throwIfWriteBlocked(input.caller);
  };
  const queueRestampIf = async (needed: boolean): Promise<void> => {
    if (!needed || restampQueued) return;
    await enqueueRestamp(userId, config.restampQueueUrl);
    restampQueued = true;
  };

  for (let round = 0; round < 5; round += 1) {
    const held = input.caller.heldClaim;
    const changesTo = (stamp: VerificationStamp) => !sameStamp(input.caller.stamp, stamp);

    // Step 3: the unit the account already holds. Refresh as before; no claim change, not counted.
    // REL-46 (D14): when only the district changed, on lines newer than the 119th, the lines moved,
    // not the voter. No re-stamp, so past votes keep the district they were cast in; new votes get the new one.
    if (held?.unitKey === keys.unitKey) {
      const districtOnly = onlyDistrictDiffers(input.caller.stamp, verifiedStamp) && onLinesAfter119th(input.geocode);
      await queueRestampIf(changesTo(verifiedStamp) && !districtOnly);
      const outcome = await writePii(piiUpdateInput(userId, verifiedPiiUpdate(input), heldClaimCondition(held)));
      if (outcome === "pii_conflict") {
        await reread();
        continue;
      }
      if (districtOnly && !restampQueued) {
        emitIntegrityMetric(METRIC_RESTAMP_SKIPPED_DISTRICT_ONLY, { verificationLimitsMode: mode });
        logger.info("Vote re-stamp skipped: only the district changed at the same address", {
          verificationLimitsMode: mode,
          congress: input.geocode.congress,
          vintage: input.geocode.vintage,
        });
      }
      finishAddressWrite(input, mode, "same_address");
      return json(200, verifiedBody(input));
    }

    // Step 4: at most MAX_ADDRESS_CHANGES_PER_WINDOW changes to a new address in ADDRESS_CHANGE_WINDOW_MS.
    const allowedAt = nextAddressChangeAllowedAt(input.caller.addressChangeLog, nowMs);
    if (allowedAt !== null) {
      if (!reverificationReported) {
        reverificationReported = true;
        emitIntegrityMetric(METRIC_REVERIFICATION_LIMIT_REACHED, {
          verificationLimitsMode: mode,
          outcome: mode === "enforce" ? "refused" : "would_refuse",
        });
      }
      if (mode === "enforce") {
        logger.info("District verification refused", { requestType: "address_geocode", outcome: "rate_limited" });
        return reverificationLimitedResponse(allowedAt, nowMs);
      }
    }

    // Step 5: the re-stamp message goes first, whenever the outcome (verified, or capped in
    // enforce) changes the stamp the account's votes carry.
    await queueRestampIf(changesTo(verifiedStamp) || (mode === "enforce" && changesTo(UNVERIFIED_STAMP)));

    // Step 6.
    const update = piiUpdateInput(userId, claimingPiiUpdate(input, keys), heldClaimCondition(held));
    const outcome = await claimAddress({ tableName, userId, keys, held, mode, nowIso, update });
    if (outcome === "claimed") {
      await reportNewClaim(tableName, keys, mode);
      finishAddressWrite(input, mode, "verified");
      return json(200, verifiedBody(input));
    }
    if (outcome === "pii_conflict") {
      await reread();
      continue;
    }

    // Step 7 (enforce only): the unit is full. Release claims of deleted accounts once, retry.
    if (!selfHealed) {
      selfHealed = true;
      const healed = await releaseStaleUnitClaims({
        db,
        tableName,
        pii: { tableName: TABLE_NAME, partitionKey: PARTITION_KEY },
        unitKey: keys.unitKey,
        streetKey: keys.streetKey,
      });
      logger.info("Address limit self-heal", healed);
      if (healed.released > 0) continue;
    }

    // Still full: save the district as self-attested and release the previous claim.
    const capped = await writeReleasingClaim(
      tableName,
      userId,
      held,
      piiUpdateInput(userId, cappedPiiUpdate(input), heldClaimCondition(held)),
    );
    if (capped === "pii_conflict") {
      await reread();
      continue;
    }
    emitIntegrityMetric(METRIC_ADDRESS_LIMIT_REACHED, { verificationLimitsMode: mode, outcome: "capped" });
    finishAddressWrite(input, mode, "capped");
    return json(200, cappedBody(input));
  }
  throw new Error("districtVerification: the address verification did not settle");
}

// ─── Manual mode ──────────────────────────────────────────────────────────────

function manualPiiUpdate(input: {
  state: string;
  selectedDistrict: string;
  ip: string | null;
  ipStateObserved: string | null;
  ipStateConsistency: Consistency;
  nowIso: string;
}): PiiUpdate {
  const update: PiiUpdate = {
    set: [
      "verificationStatus = :verificationStatus",
      "verificationMethod = :verificationMethod",
      "constituentVerified = :constituentVerified",
      "verifiedAt = :verifiedAt",
      "selfAttestedState = :selfAttestedState",
      "selfAttestedDistrict = :selfAttestedDistrict",
      "claimedDistrict = :claimedDistrict",
      "ipStateConsistency = :ipStateConsistency",
      "updatedAt = :updatedAt",
    ],
    remove: ["districtClaimMatch", "resolvedState", "resolvedDistrict", "verificationLimitReason"],
    values: {
      ":verificationStatus": { S: "self_attested" },
      ":verificationMethod": { S: "manual_state_district" },
      ":constituentVerified": { BOOL: false },
      ":verifiedAt": { S: input.nowIso },
      ":selfAttestedState": { S: input.state },
      ":selfAttestedDistrict": { S: input.selectedDistrict },
      ":claimedDistrict": { S: input.selectedDistrict },
      ":ipStateConsistency": { S: input.ipStateConsistency },
      ":updatedAt": { S: input.nowIso },
    },
  };
  if (input.ipStateObserved) {
    update.set.push("ipStateObserved = :ipStateObserved");
    update.values[":ipStateObserved"] = { S: input.ipStateObserved };
  } else {
    update.remove.push("ipStateObserved");
  }
  if (input.ip) {
    update.set.push("ipHash = :ipHash");
    update.values[":ipHash"] = { S: toHash(input.ip) };
  } else {
    update.remove.push("ipHash");
  }
  return update;
}

/**
 * Manual (self-attested) mode as before, except that a held claim is released in the same
 * transaction as the UserPII write, and a re-stamp is queued first when the stamp changes.
 */
async function selectDistrictManually(
  userId: string,
  initialCaller: CallerState,
  update: PiiUpdate,
  config: LimitsConfig,
): Promise<void> {
  let caller = initialCaller;
  let restampQueued = false;
  for (let round = 0; round < 2; round += 1) {
    if (!restampQueued && !sameStamp(caller.stamp, UNVERIFIED_STAMP)) {
      await enqueueRestamp(userId, config.restampQueueUrl);
      restampQueued = true;
    }
    let outcome: WriteOutcome;
    if (!config.claimsTableName) {
      outcome = await writePii(piiUpdateInput(userId, update));
    } else {
      const withoutClaim: PiiUpdate = {
        ...update,
        remove: [...update.remove, "verifiedAddressKey", "verifiedStreetKey"],
      };
      outcome = await writeReleasingClaim(
        config.claimsTableName,
        userId,
        caller.heldClaim,
        piiUpdateInput(userId, withoutClaim, heldClaimCondition(caller.heldClaim)),
      );
    }
    if (outcome === "ok") return;
    caller = await readCallerState(userId);
    throwIfWriteBlocked(caller);
  }
  throw new Error("districtVerification: a concurrent verification of this account did not settle");
}

async function handlePost(userId: string, event: APIGatewayProxyEvent, caller: CallerState) {
  const body = parseJsonBody(event) as VerificationRequest;

  const line1 = typeof body.line1 === "string" ? body.line1.trim() : "";
  const line2 = typeof body.line2 === "string" ? body.line2.trim() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const state = normalizeState(body.state);
  const zip = normalizeZip(body.zip);
  const claimedDistrictRaw = body.district ?? body.claimedDistrict;
  const hasAddressInput = Boolean(line1 || line2 || city || zip);
  const hasManualDistrictInput = typeof claimedDistrictRaw === "string" && claimedDistrictRaw.trim().length > 0;
  const config = limitsConfig();

  // Address mode: geocode and verify.
  if (hasAddressInput) {
    if (!line1 || !city || !state || !zip) {
      return json(400, {
        error: "Missing or invalid address fields (line1, city, state, zip)",
      });
    }

    const { result: geocodeResult, attempts } = await resolveDistrictFromAddress({
      line1,
      line2,
      city,
      state,
      zip,
    });
    if (!geocodeResult) {
      console.warn("districtVerification geocode unresolved", {
        requestType: "address_geocode",
        state,
        zip,
        cityHash: toHash(city),
        line1Hash: toHash(line1),
        line2Hash: line2 ? toHash(line2) : undefined,
        attemptCount: attempts.length,
        attempts,
      });
      return json(422, {
        error: "Unable to resolve congressional district for this address",
      });
    }

    const claimedDistrict = normalizeClaimedDistrict(geocodeResult.state, claimedDistrictRaw);
    const districtClaimMatch = claimedDistrict ? claimedDistrict === geocodeResult.districtId : null;

    // INT-02: the IP state comes only from the provider lookup (off unless IP_LOOKUP_ENABLED). A
    // mismatch is stored and counted, and never changes the verification.
    const ip = getSourceIp(event);
    const ipStateObserved = ip ? await lookupIpStateFromProvider(ip) : null;

    const ipStateConsistency: Consistency = ipStateObserved
      ? ipStateObserved === geocodeResult.state
        ? "match"
        : "mismatch"
      : "unknown";

    let matchedAddress = geocodeResult.matchedAddress;
    if (!matchedAddress) {
      // The Census match always carries one; rebuild it from the request in its format if not.
      logger.warn("Census match has no matchedAddress; keying the address from the request");
      matchedAddress = [stripUnitSuffix(line1), city, state, zip].join(", ");
    }

    const input: AddressVerificationInput = {
      userId,
      caller,
      geocode: geocodeResult,
      matchedAddress,
      unit: unitFromAddressLines(line1, line2),
      claimedDistrict,
      districtClaimMatch,
      ip,
      ipStateObserved,
      ipStateConsistency,
      nowIso: new Date().toISOString(),
    };

    return config.claimsTableName
      ? await verifyAddressWithLimits(input, { ...config, claimsTableName: config.claimsTableName })
      : await verifyAddressWithoutLimits(input, config);
  }

  // Manual mode: state + district only, no address verification.
  if (!state || !hasManualDistrictInput) {
    return json(400, {
      error:
        "Provide a full address (line1, city, state, zip) or provide both state and district for manual selection.",
    });
  }

  const selectedDistrict = normalizeClaimedDistrict(state, claimedDistrictRaw);
  if (!selectedDistrict) {
    return json(400, {
      error: "Invalid district format. Use values like '12', 'AL', or 'CA-12'.",
    });
  }

  const ip = getSourceIp(event);
  const ipStateObserved = ip ? await lookupIpStateFromProvider(ip) : null;

  const ipStateConsistency: Consistency = ipStateObserved
    ? ipStateObserved === state
      ? "match"
      : "mismatch"
    : "unknown";

  const nowIso = new Date().toISOString();
  const update = manualPiiUpdate({ state, selectedDistrict, ip, ipStateObserved, ipStateConsistency, nowIso });
  await selectDistrictManually(userId, caller, update, config);

  return json(200, {
    verified: false,
    status: "self_attested",
    method: "manual_state_district",
    verifiedAt: nowIso,
    resolved: {
      state,
      districtId: selectedDistrict,
    },
    signals: {
      addressGeocoded: false,
      ipStateConsistency,
      ipStateObserved,
      districtClaimMatch: null,
    },
    repsSignalEligible: false,
    nextStep: MANUAL_NEXT_STEP,
  });
}

export async function handler(
  event: APIGatewayProxyEvent,
  context?: LambdaContextLike,
): Promise<APIGatewayProxyResult> {
  logger.resetContext(context);
  try {
    const userId = getUserId(event);
    if (!userId) {
      return json(401, { message: "Unauthorized (missing authorizer claims)" });
    }
    logger.appendKeys({ userId });

    await ensureHashSalt();

    const method = (event?.httpMethod ?? "").toUpperCase();

    if (method === "GET") {
      return await handleGet(userId);
    }

    if (method === "POST") {
      const caller = await readCallerState(userId);
      const blockedReason = writeEligibilityBlockReason(caller.eligibility);
      if (blockedReason) {
        return toForbiddenResponse(blockedReason);
      }

      return await handlePost(userId, event, caller);
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof WriteBlockedError) {
      logger.info("District verification refused: the account is being deleted", { reason: error.reason });
      return toForbiddenResponse(error.reason);
    }
    logger.error("districtVerification failed", { error });
    return json(500, { error: "Internal server error" });
  }
}

export default { handler };
