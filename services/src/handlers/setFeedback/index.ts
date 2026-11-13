import { DynamoDBClient, GetItemCommand, PutItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import {
  FIRST_VOTED_AT_ATTRIBUTE,
  firstVotedAtFor,
  FORMERLY_FAILED_MARKER_PK,
  isDismissableBillStatus,
  isValidFeedback,
  LEGACY_DISMISS_ATTRIBUTE,
  normalizeFeedbackReasons,
} from "../../models/feedback";
import {
  normalizeAdultStatus,
  normalizeDeletionStatus,
  toForbiddenResponse,
  writeEligibilityBlockReason,
} from "../../shared/adultEligibility";
import { companionIndex, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import { evaluateRequestAttestation } from "../../shared/appAttest/evaluate";
import { sendsAppVersion } from "../../shared/appAttest/wire";
import { emitEmbeddedMetric } from "../../shared/metrics";
import {
  applyVoteDailyCap,
  emitVoteCast,
  parseVoteDailyCapMode,
  voteDailyLimitResponse,
} from "../../shared/voteDailyCap";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? PARTITION_KEY;
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_GUID_LOOKUP_PK = process.env.MANIFEST_GUID_LOOKUP_PK ?? "BILL_GUID";
// INT-06 (C2 3.2): "watch" counts and never refuses; "enforce" answers 429 over VOTE_DAILY_LIMIT a UTC day.
const VOTE_DAILY_CAP_MODE = parseVoteDailyCapMode(process.env.VOTE_DAILY_CAP_MODE);
// 2C (INT-08): every new vote row stores weight 1. The field stays for readers of older rows (some
// hold 1.25); the stats no longer read it.
const VOTE_WEIGHT = "1";
// INT-11: the companion groups, read for an Abstain from 1.0 or 1.1 on a bill that is not itself Passed or Failed
// (isLegacyDismissal), at most every 60 s, as GET /bill-stats reads them.
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
// INT-11's LegacyDismissStored, and UX-31's EarlierVoteReadFailed (a vote not stored: its earlier row was unreadable).
const RESULTS_METRIC_NAMESPACE = "BillBoard/BillStats";

const db = new DynamoDBClient({});
const companionDao = MANIFEST_TABLE_NAME ? new BillCompanionDao(db) : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

function parseJsonBody(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  try {
    if (!event?.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

type BillMetadataSnapshot = {
  exists: boolean;
  /** The manifest's billStatus (INT-11: isLegacyDismissal). */
  billStatus?: string;
  civicProfile?: Record<string, { N: string }>;
  lifeAreas?: string[];
  subCategories?: string[];
};

function parseStringListAttribute(attribute: AttributeValue | undefined): string[] | undefined {
  const values = Array.isArray(attribute?.L)
    ? attribute.L.map((entry: AttributeValue) => entry?.S).filter(
        (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  return values.length > 0 ? values : undefined;
}

/**
 * The bill's BILL row in the manifest with only `projection`, or null when the bill has no lookup row or BILL row.
 * Errors are thrown. Needs MANIFEST_TABLE_NAME.
 */
async function readManifestBillRow(billId: string, projection: string): Promise<Record<string, AttributeValue> | null> {
  // Lookup row shape:
  // pk="BILL_GUID", sk="<guid>", manifestSk="<updatedAt>#<guid>"
  const lookup = await db.send(
    new GetItemCommand({
      TableName: MANIFEST_TABLE_NAME,
      Key: {
        [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_GUID_LOOKUP_PK },
        [MANIFEST_SORT_KEY]: { S: billId },
      },
      ProjectionExpression: "manifestSk",
    }),
  );
  const manifestSk = lookup.Item?.manifestSk?.S;
  if (!manifestSk) return null;

  const result = await db.send(
    new GetItemCommand({
      TableName: MANIFEST_TABLE_NAME,
      Key: {
        [MANIFEST_PRIMARY_KEY]: { S: "BILL" },
        [MANIFEST_SORT_KEY]: { S: manifestSk },
      },
      ProjectionExpression: projection,
    }),
  );
  return result.Item ?? null;
}

/**
 * Look up bill metadata used for downstream civic analytics, and the bill's status.
 */
async function lookupBillMetadata(billId: string): Promise<BillMetadataSnapshot> {
  if (!MANIFEST_TABLE_NAME) return { exists: true };

  try {
    const item = await readManifestBillRow(billId, "civicProfile, lifeAreas, subCategories, billStatus");
    if (!item) return { exists: false };
    const billStatus = item.billStatus?.S;
    const cpMap = item?.civicProfile?.M;
    const hasNumeric = cpMap && typeof cpMap === "object" && Object.values(cpMap).some((v) => v?.N !== undefined);
    const lifeAreas = parseStringListAttribute(item?.lifeAreas);
    const subCategories = parseStringListAttribute(item?.subCategories);

    if (!hasNumeric && !lifeAreas && !subCategories) {
      return { exists: true, billStatus };
    }

    return {
      exists: true,
      billStatus,
      civicProfile: hasNumeric ? (cpMap as Record<string, { N: string }>) : undefined,
      lifeAreas,
      subCategories,
    };
  } catch (err) {
    console.warn("Failed to look up bill metadata for bill:", billId, err);
    return { exists: !MANIFEST_TABLE_NAME };
  }
}

/**
 * REL-50: whether the bill has its "formerly failed" marker: its manifest row was Failed and may since be open
 * (FORMERLY_FAILED_MARKER_PK in models/feedback.ts; CreateBillsManifest and repair:failed-status write it). One GetItem;
 * errors are thrown. False without MANIFEST_TABLE_NAME.
 */
async function isFormerlyFailed(billId: string): Promise<boolean> {
  if (!MANIFEST_TABLE_NAME) return false;
  const result = await db.send(
    new GetItemCommand({
      TableName: MANIFEST_TABLE_NAME,
      Key: {
        [MANIFEST_PRIMARY_KEY]: { S: FORMERLY_FAILED_MARKER_PK },
        [MANIFEST_SORT_KEY]: { S: billId },
      },
      ProjectionExpression: "#sk",
      ExpressionAttributeNames: { "#sk": MANIFEST_SORT_KEY },
    }),
  );
  return result.Item !== undefined;
}

/**
 * INT-11: whether this Abstain is a 1.0 or 1.1 dismissal, not a vote. Those builds (no X-Billboard-App-Version)
 * write Abstain when the user dismisses a Passed or Failed bill in Updates. 1.0 knows no companion groups, but shows a
 * House and a Senate bill with the same number or title as one card under the House guid, with the House bill's
 * status, or the Senate bill's when the House row has none. 1.1 writes a group's dismissal only while no member holds
 * the user's vote, and so to the group's vote target, the House primary. Either way the dismissal can land on a House
 * bill that is still New while the Senate member has passed, and never on the Senate member for its House bill. So an
 * Abstain from them is a dismissal when the bill is Passed or Failed, or when it is a group's primary and another
 * member is. REL-50: a bill whose row was Failed and is open now (isFormerlyFailed: REL-50 put a false Failed right)
 * counts as Failed here, since those builds never lower a status they hold and can still list it under Failed Bills. An Abstain on any
 * other member is judged by that member's own status. An explicit Abstain those builds send on such a bill looks the same and
 * is treated the same (it unlocks nothing; a Yea or Nay does). 1.2 and later send the header and never write Abstain
 * for a dismissal. Throws when the groups, a member's row or a marker cannot be read, so the handler answers 500 rather
 * than guess.
 */
async function isLegacyDismissal(
  event: APIGatewayProxyEvent,
  feedback: string,
  billId: string,
  billStatus: string | undefined,
): Promise<boolean> {
  if (feedback !== "Abstain" || sendsAppVersion(event)) return false;
  if (isDismissableBillStatus(billStatus)) return true;
  if (await isFormerlyFailed(billId)) return true;
  if (!companionDao) return false;
  const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
  if (companionIndexFor?.state !== state) {
    companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
  }
  const group = companionIndexFor.index.get(billId);
  if (group?.primaryGuid !== billId) return false;
  for (const member of group.memberGuids) {
    if (member === billId) continue;
    const row = await readManifestBillRow(member, "billStatus");
    if (isDismissableBillStatus(row?.billStatus?.S) || (await isFormerlyFailed(member))) return true;
  }
  return false;
}

/**
 * UX-31: the caller's row on the bill as it stands, for the first-vote time the new row keeps (firstVotedAtFor). A
 * strongly consistent GetItem keyed by the authorizer's sub; errors are thrown.
 */
async function readEarlierVote(userId: string, billId: string): Promise<Record<string, AttributeValue> | undefined> {
  const result = await db.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { [PARTITION_KEY]: { S: userId }, [SORT_KEY]: { S: billId } },
      ProjectionExpression: "feedback, votedAt, #firstVotedAt, #legacyDismiss",
      ExpressionAttributeNames: {
        "#firstVotedAt": FIRST_VOTED_AT_ATTRIBUTE,
        "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
      },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

type VerificationSnapshot = {
  verified: boolean;
  verificationStatus: string;
  resolvedState?: string;
  resolvedDistrict?: string;
  adultStatus: "attested_adult" | "self_reported_under18" | "unknown";
  deletionStatus: "not_requested" | "in_progress" | "completed" | "failed";
  adultEligible: boolean;
};

/**
 * Reads the caller's district-verification and eligibility state.
 *
 * Fails closed: a missing PII table or a DynamoDB error is thrown (the handler
 * turns it into a 500) instead of being reported as an unverified, eligible
 * user, because that default would let writes through during an outage.
 */
async function lookupVerificationSnapshot(userId: string): Promise<VerificationSnapshot> {
  if (!PII_TABLE_NAME) {
    throw new Error("PII_TABLE_NAME is not configured; cannot evaluate feedback eligibility.");
  }

  const result = await db.send(
    new GetItemCommand({
      TableName: PII_TABLE_NAME,
      Key: { [PII_PARTITION_KEY]: { S: userId } },
      ProjectionExpression:
        "constituentVerified, verificationStatus, resolvedState, resolvedDistrict, adultStatus, deletionStatus",
    }),
  );

  const item = result.Item;
  const verified = item?.constituentVerified?.BOOL === true;
  const verificationStatus = item?.verificationStatus?.S ?? (verified ? "likely_constituent" : "self_attested");
  const adultStatus = normalizeAdultStatus(item?.adultStatus?.S);
  const deletionStatus = normalizeDeletionStatus(item?.deletionStatus?.S);

  return {
    verified,
    verificationStatus,
    resolvedState: verified ? item?.resolvedState?.S : undefined,
    resolvedDistrict: verified ? item?.resolvedDistrict?.S : undefined,
    adultStatus,
    deletionStatus,
    adultEligible: adultStatus !== "self_reported_under18",
  };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;

  const userId = claims?.sub;

  if (!userId) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Unauthorized (missing authorizer claims)" }),
    };
  }

  const body = parseJsonBody(event);
  const requestedBillId = typeof body?.billId === "string" ? body.billId.trim() : String(body?.billId ?? "").trim();
  // Votes are kept under the plain guid; a legacy id (BILLS-119hr1181rh) names the same bill.
  const billId = plainBillGuid(requestedBillId) ?? requestedBillId;
  const feedback = body?.feedback;
  const reasons = normalizeFeedbackReasons(body?.reasons);

  if (!billId || !feedback) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing billId or feedback" }),
    };
  }

  if (!isValidFeedback(feedback)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid feedback value" }),
    };
  }

  if (reasons === null) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid reasons value" }),
    };
  }

  // Look up civic profile scores from manifest (best effort)
  const billMetadata = await lookupBillMetadata(billId);
  if (!billMetadata.exists) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unknown billId" }),
    };
  }
  let legacyDismiss: boolean;
  try {
    legacyDismiss = await isLegacyDismissal(event, feedback, billId, billMetadata.billStatus);
  } catch (err) {
    console.error("Could not read the bill's companion group to classify an Abstain; not storing it:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
  let verificationSnapshot: VerificationSnapshot;
  try {
    verificationSnapshot = await lookupVerificationSnapshot(userId);
  } catch (err) {
    console.error("Failed to read eligibility snapshot for feedback:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
  const blockedReason = writeEligibilityBlockReason(verificationSnapshot);
  if (blockedReason) {
    return toForbiddenResponse(blockedReason);
  }

  // App Attest (INT-04, C3 3.4). APP_ATTEST_MODE: off when unset or without APP_ATTEST_TABLE_NAME (no
  // call, no attribute); watch records the outcome and never blocks; enforce answers 403, 426 or 503.
  // Never throws. It runs before the INT-06 counter, so a blocked vote never uses the day's quota, and
  // after the eligibility check, so an account being deleted never gets a new install binding (X5).
  const attestation = await evaluateRequestAttestation(event, userId, "feedback");
  if (attestation.blocked && attestation.response) {
    return attestation.response;
  }

  // INT-06: count this write on the caller's PII row (creating the row when there is none). Only after
  // the eligibility check, so an ineligible or deleted account never gets a counter.
  const cap = await applyVoteDailyCap({
    db,
    tableName: PII_TABLE_NAME!,
    partitionKey: PII_PARTITION_KEY,
    userId,
    mode: VOTE_DAILY_CAP_MODE,
  });
  if (cap.action === "refuse_limit") {
    return voteDailyLimitResponse(cap.retryAfterSeconds);
  }
  if (cap.action === "refuse_deleting") {
    // A deletion that started after the eligibility read: refuse exactly as that check would have.
    return toForbiddenResponse(
      writeEligibilityBlockReason({ adultStatus: "unknown", deletionStatus: cap.deletionStatus }) ??
        "ACCOUNT_DELETION_IN_PROGRESS",
    );
  }
  if (cap.action === "error") {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }

  // UX-31: the row replaces the earlier one whole, so the time of the first vote on the bill is read first and kept.
  // A changed vote keeps it, and the Civic Score counts the vote's day by it. Without it the vote is not stored: the
  // write would stamp an old vote as new. That 500 is returned, not thrown, so the alias Errors alarm never counts it:
  // EarlierVoteReadFailed has its own alarm (Billboard-Votes-EarlierVoteReadFailed, RUNBOOK 19.6).
  const votedAt = new Date().toISOString();
  let firstVotedAt: ReturnType<typeof firstVotedAtFor>;
  try {
    firstVotedAt = firstVotedAtFor(await readEarlierVote(userId, String(billId)), votedAt, !legacyDismiss);
  } catch (err) {
    console.error("Could not read the caller's earlier vote on the bill; not storing the vote:", err);
    emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "EarlierVoteReadFailed", 1);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }

  const item: Record<string, AttributeValue> = {
    [PARTITION_KEY]: { S: userId },
    [SORT_KEY]: { S: String(billId) },
    feedback: { S: String(feedback) },
    votedAt: { S: votedAt },
    effectiveWeight: { N: VOTE_WEIGHT },
    constituentVerified: { BOOL: verificationSnapshot.verified },
    verificationStatus: { S: verificationSnapshot.verificationStatus },
    adultEligible: { BOOL: verificationSnapshot.adultEligible },
  };

  if (firstVotedAt) {
    item[FIRST_VOTED_AT_ATTRIBUTE] = firstVotedAt;
  }

  if (verificationSnapshot.resolvedState) {
    item.resolvedState = { S: verificationSnapshot.resolvedState };
  }

  if (verificationSnapshot.resolvedDistrict) {
    item.resolvedDistrict = { S: verificationSnapshot.resolvedDistrict };
  }

  if (billMetadata.civicProfile) {
    item.civicProfile = { M: billMetadata.civicProfile };
  }

  if (billMetadata.lifeAreas?.length) {
    item.lifeAreas = { L: billMetadata.lifeAreas.map((value) => ({ S: value })) };
  }

  if (billMetadata.subCategories?.length) {
    item.subCategories = { L: billMetadata.subCategories.map((value) => ({ S: value })) };
  }

  if (reasons.length > 0) {
    item.reasons = { SS: reasons };
  }

  // C3 4.2: the outcome rides on the existing write. GET /feedback does not project it and the stats
  // aggregator ignores it.
  if (attestation.outcome) {
    item.appAttest = { S: attestation.outcome };
  }

  // INT-11: kept, so 1.0 and 1.1 still see the bill as handled, but it unlocks no results (models/feedback.ts).
  if (legacyDismiss) {
    item[LEGACY_DISMISS_ATTRIBUTE] = { BOOL: true };
  }

  await db.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item,
    }),
  );
  emitVoteCast({ userId, mode: VOTE_DAILY_CAP_MODE, voteDay: cap.voteDay, voteDayCount: cap.voteDayCount });
  if (legacyDismiss) {
    emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "LegacyDismissStored", 1);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Feedback submitted" }),
  };
}
