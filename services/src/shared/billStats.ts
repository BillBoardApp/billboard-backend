import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { LEGACY_DISMISS_ATTRIBUTE, unlocksResults } from "../models/feedback";

const STATS_PAYLOAD_ATTRIBUTE = "payload";
const STATS_UPDATED_AT_ATTRIBUTE = "updatedAt";
// When the stored computation started reading votes; orders concurrent recomputes (see writeCachedStats).
const STATS_COMPUTED_FROM_ATTRIBUTE = "computedFrom";
/**
 * On a BillsManifest row: the computationStartedAt of the recompute that wrote its voteCount.
 * billStatsAggregator only overwrites a count written by a computation that started no later, and
 * createBillsManifest carries the attribute along with voteCount when it rewrites the row.
 */
export const MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE = "voteCountComputedFrom";
// Kept at "4" through 2C (INT-08): payloads cached at the old 1.25 weight are normalized on read by
// toServedStats, so no cached row is invalidated or rewritten.
const STATS_SCHEMA_VERSION = "4";

const BILL_STATS_REASON_MIN_COUNT = Number.parseInt(process.env.BILL_STATS_REASON_MIN_COUNT ?? "5", 10);

/**
 * Fewest Yea + Nay votes a state rollup, district rollup or the verified segment needs before its
 * split is published. Matches the app's VoterMapStyling.lowSampleThreshold.
 */
export const STATS_MIN_DECISION_VOTES = 5;

/** Running counts of one scope while votes are folded. Every vote counts 1 (2C, INT-08). */
type StatsBucket = {
  votes: number;
  yea: number;
  nay: number;
  abstain: number;
};

/**
 * Plain counts of one group of voters, every vote counted once: the OpenAPI `VoteSplit` (VoteSplitV1).
 * yeaPct is 0 to 100 over Yea + Nay, rounded to 4 decimals, or null when there are none.
 */
export type VoteSplit = {
  votes: number;
  yea: number;
  nay: number;
  abstain: number;
  decisionVotes: number;
  yeaPct: number | null;
};

/**
 * One scope as served: the OpenAPI `VoteBucket`. Since 2C every weighted* field equals its plain
 * counterpart; the fields stay because app builds 1.0 and R1 decode them (and read weightedYeaPct).
 */
export type VoteBucket = VoteSplit & {
  weightedVotes: number;
  weightedYea: number;
  weightedNay: number;
  weightedAbstain: number;
  weightedDecisionVotes: number;
  weightedYeaPct: number | null;
};

/**
 * All users beside verified constituents, national only: the OpenAPI `BillStatsComparison`
 * (BillStatsComparisonV1). `verified` is absent exactly when `verifiedWithheld` is true.
 */
export type BillStatsComparison = {
  allUsers: VoteSplit;
  verified?: VoteSplit;
  verifiedWithheld: boolean;
  minDecisionVotes: number;
};

type BucketWithPercentages = VoteBucket;

type ReasonBreakdownBucket = {
  reasonKey: string;
  count: number;
  pct: number;
};

type ReasonBreakdownSide = {
  voteCount: number;
  reasons: ReasonBreakdownBucket[];
};

type BillReasonBreakdown = {
  minCount: number;
  yea: ReasonBreakdownSide;
  nay: ReasonBreakdownSide;
};

export type BillStatsResponse = {
  billId: string;
  generatedAt: string;
  totals: BucketWithPercentages;
  segments: {
    verified: BucketWithPercentages;
    selfAttested: BucketWithPercentages;
  };
  rollups: {
    byState: Record<
      string,
      {
        state: string;
        totals: BucketWithPercentages;
        segments: {
          verified: BucketWithPercentages;
          selfAttested: BucketWithPercentages;
        };
      }
    >;
    byDistrict: Record<
      string,
      {
        state: string;
        district: string;
        totals: BucketWithPercentages;
        segments: {
          verified: BucketWithPercentages;
          selfAttested: BucketWithPercentages;
        };
      }
    >;
  };
  reasonBreakdown: BillReasonBreakdown;
  /** Added by toServedStats on every 200 body of GET /bill-stats; never stored. */
  comparison?: BillStatsComparison;
};

type ScopedBuckets = {
  totals: StatsBucket;
  verified: StatsBucket;
  selfAttested: StatsBucket;
};

type ComputeBillStatsParams = {
  db: DynamoDBClient;
  tableName: string;
  /** Unused since the query stopped projecting the key attributes; kept so callers need not change. */
  partitionKey: string;
  sortKey: string;
  billIdIndexName: string;
  billId: string;
};

/** The feedback table and bill-id GSI a companion group's votes are read from (APPF-23). */
type ComputeCompanionStatsParams = {
  db: Pick<DynamoDBClient, "send">;
  tableName: string;
  /** The feedback table's partition key (the user id); the GSI projects it like every key attribute. */
  userIdAttribute: string;
  /** The feedback table's sort key (the bill id), the GSI's partition key. */
  sortKey: string;
  billIdIndexName: string;
  /** companionStatsKey(group): the billId the combined stats are stored and served under. */
  statsKey: string;
  /** The group's members, primary first. */
  memberGuids: readonly string[];
};

type ReadCachedStatsParams = {
  db: DynamoDBClient;
  statsTableName?: string;
  statsPartitionKey: string;
  billId: string;
};

type WriteCachedStatsParams = {
  db: DynamoDBClient;
  statsTableName?: string;
  statsPartitionKey: string;
  stats: BillStatsResponse;
  /**
   * ISO time at which the computation started reading votes. When set, the write only lands if no
   * computation that started later has stored its result already, so a slow recompute that raced a
   * newer one cannot leave older stats behind.
   */
  computationStartedAt?: string;
};

/** "written", or "superseded" when a computation that started later had already stored its stats. */
export type WriteCachedStatsOutcome = "written" | "superseded" | "disabled";

function createBucket(): StatsBucket {
  return { votes: 0, yea: 0, nay: 0, abstain: 0 };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** A served bucket whose weighted* fields equal the plain ones (2C); idempotent. */
function equalWeightBucket(bucket: VoteBucket): VoteBucket {
  if (!bucket || typeof bucket !== "object") return bucket;
  return {
    ...bucket,
    weightedVotes: bucket.votes,
    weightedYea: bucket.yea,
    weightedNay: bucket.nay,
    weightedAbstain: bucket.abstain,
    weightedDecisionVotes: bucket.decisionVotes,
    weightedYeaPct: bucket.yeaPct,
  };
}

function withPercentages(bucket: StatsBucket): VoteBucket {
  const decisionVotes = bucket.yea + bucket.nay;
  const yeaPct = decisionVotes > 0 ? round((bucket.yea / decisionVotes) * 100) : null;

  return {
    votes: bucket.votes,
    yea: bucket.yea,
    nay: bucket.nay,
    abstain: bucket.abstain,
    decisionVotes,
    yeaPct,
    weightedVotes: bucket.votes,
    weightedYea: bucket.yea,
    weightedNay: bucket.nay,
    weightedAbstain: bucket.abstain,
    weightedDecisionVotes: decisionVotes,
    weightedYeaPct: yeaPct,
  };
}

function applyVote(bucket: StatsBucket, feedback: string) {
  bucket.votes += 1;

  if (feedback === "Yea") {
    bucket.yea += 1;
    return;
  }
  if (feedback === "Nay") {
    bucket.nay += 1;
    return;
  }

  bucket.abstain += 1;
}

function createScopedBuckets(): ScopedBuckets {
  return {
    totals: createBucket(),
    verified: createBucket(),
    selfAttested: createBucket(),
  };
}

function applyVoteToScope(scope: ScopedBuckets, feedback: string, isVerified: boolean) {
  applyVote(scope.totals, feedback);
  applyVote(isVerified ? scope.verified : scope.selfAttested, feedback);
}

function normalizeToken(value?: string): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function toSortedObject<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function resolveReasonMinCount(): number {
  if (!Number.isFinite(BILL_STATS_REASON_MIN_COUNT)) return 5;
  return Math.max(1, Math.trunc(BILL_STATS_REASON_MIN_COUNT));
}

function buildReasonBuckets(
  reasonCounts: Map<string, number>,
  voteCount: number,
  minCount: number,
): ReasonBreakdownBucket[] {
  return Array.from(reasonCounts.entries())
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([reasonKey, count]) => ({
      reasonKey,
      count,
      pct: voteCount > 0 ? round((count / voteCount) * 100) : 0,
    }));
}

export function createEmptyBillStats(billId: string): BillStatsResponse {
  const totals = withPercentages(createBucket());
  const minCount = resolveReasonMinCount();
  return {
    billId,
    generatedAt: new Date().toISOString(),
    totals,
    segments: {
      verified: totals,
      selfAttested: totals,
    },
    rollups: {
      byState: {},
      byDistrict: {},
    },
    reasonBreakdown: {
      minCount,
      yea: { voteCount: 0, reasons: [] },
      nay: { voteCount: 0, reasons: [] },
    },
  };
}

/** A stored stats document, with when the computation that wrote it started reading votes. */
export type StoredBillStats = {
  /** The payload, sample floor applied. */
  stats: BillStatsResponse;
  /**
   * The row's computedFrom (writeCachedStats' computationStartedAt): ISO time. Absent on a row written
   * without it; stats.generatedAt, when that computation finished reading, is the bound then.
   */
  computedFrom?: string;
};

/**
 * The stored stats document of `billId` and its computedFrom, or null when there is none, it has
 * another schema version, or it cannot be read (logged).
 */
export async function readStoredStats({
  db,
  statsTableName,
  statsPartitionKey,
  billId,
}: ReadCachedStatsParams): Promise<StoredBillStats | null> {
  if (!statsTableName) return null;

  try {
    const result = await db.send(
      new GetItemCommand({
        TableName: statsTableName,
        Key: { [statsPartitionKey]: { S: billId } },
        ProjectionExpression: `${STATS_PAYLOAD_ATTRIBUTE}, schemaVersion, ${STATS_COMPUTED_FROM_ATTRIBUTE}`,
      }),
    );

    const schemaVersion = result.Item?.schemaVersion?.S;
    if (schemaVersion !== STATS_SCHEMA_VERSION) return null;

    const payload = result.Item?.[STATS_PAYLOAD_ATTRIBUTE]?.S;
    if (!payload) return null;

    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;

    const computedFrom = result.Item?.[STATS_COMPUTED_FROM_ATTRIBUTE]?.S;
    // Payloads cached before the sample floor existed are floored on the way out.
    return {
      stats: applyStatsSampleFloor(parsed as BillStatsResponse),
      ...(computedFrom ? { computedFrom } : {}),
    };
  } catch (err) {
    console.warn("Failed to read cached bill stats:", err);
    return null;
  }
}

/** The stored stats document of `billId` (readStoredStats without computedFrom), or null. */
export async function readCachedStats(params: ReadCachedStatsParams): Promise<BillStatsResponse | null> {
  return (await readStoredStats(params))?.stats ?? null;
}

export async function writeCachedStats({
  db,
  statsTableName,
  statsPartitionKey,
  stats,
  computationStartedAt,
}: WriteCachedStatsParams): Promise<WriteCachedStatsOutcome> {
  if (!statsTableName) return "disabled";

  // The cached payload is what fetchBillStats serves, so the sample floor is applied here too.
  const published = applyStatsSampleFloor(stats);

  const item: Record<string, AttributeValue> = {
    [statsPartitionKey]: { S: published.billId },
    [STATS_PAYLOAD_ATTRIBUTE]: { S: JSON.stringify(published) },
    [STATS_UPDATED_AT_ATTRIBUTE]: { S: published.generatedAt },
    schemaVersion: { S: STATS_SCHEMA_VERSION },
  };
  // Stream batches from different shards can recompute one bill at the same time. Keeping the
  // result of the computation that started last means the stored stats always come from a read that
  // began after every vote whose stream record has been handled.
  const ordering = computationStartedAt
    ? {
        ConditionExpression: "attribute_not_exists(#computedFrom) OR #computedFrom <= :computedFrom",
        ExpressionAttributeNames: { "#computedFrom": STATS_COMPUTED_FROM_ATTRIBUTE },
        ExpressionAttributeValues: { ":computedFrom": { S: computationStartedAt } },
      }
    : {};
  if (computationStartedAt) item[STATS_COMPUTED_FROM_ATTRIBUTE] = { S: computationStartedAt };

  // Errors propagate: the feedback stream mapping retries (and bisects) a failed batch, while a
  // swallowed error would leave the served stats stale with nothing to show for it.
  try {
    await db.send(new PutItemCommand({ TableName: statsTableName, Item: item, ...ordering }));
    return "written";
  } catch (err) {
    if (computationStartedAt && (err as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") {
      return "superseded";
    }
    throw err;
  }
}

function meetsSampleFloor(bucket: { decisionVotes?: unknown } | null | undefined): boolean {
  const decisionVotes = bucket?.decisionVotes;
  return typeof decisionVotes === "number" && decisionVotes >= STATS_MIN_DECISION_VOTES;
}

function decisionVotesOf(rollup: { totals?: { decisionVotes?: unknown } } | null | undefined): number {
  const decisionVotes = rollup?.totals?.decisionVotes;
  return typeof decisionVotes === "number" && Number.isFinite(decisionVotes) ? decisionVotes : 0;
}

/**
 * Server-side sample floor for the published stats (idempotent). The overall totals are always kept.
 *
 * - State and district rollups under STATS_MIN_DECISION_VOTES are omitted; the app shows a missing
 *   key as "no data".
 * - A district that clears the floor is omitted too when its state total minus the districts still
 *   shown would leave 1 to 4 votes, since that subtraction would recover the hidden districts' split.
 * - When the verified segment is under the floor, or the verified total minus the states still shown
 *   would leave 1 to 4 votes, both segments are published empty: the app requires both keys, and
 *   keeping selfAttested alone would give verified = totals - selfAttested.
 */
export function applyStatsSampleFloor(stats: BillStatsResponse): BillStatsResponse {
  const byState = Object.fromEntries(
    Object.entries(stats.rollups?.byState ?? {}).filter(([, rollup]) => meetsSampleFloor(rollup?.totals)),
  );

  const districtEntries = Object.entries(stats.rollups?.byDistrict ?? {}).filter(([, rollup]) =>
    meetsSampleFloor(rollup?.totals),
  );
  const suppressedDistricts = new Set<string>();
  for (const [stateKey, stateRollup] of Object.entries(byState)) {
    const shownInState = districtEntries
      .filter(([, rollup]) => rollup.state === stateKey)
      .sort(([keyA, a], [keyB, b]) => decisionVotesOf(a) - decisionVotesOf(b) || keyA.localeCompare(keyB));
    let hiddenVotes =
      decisionVotesOf(stateRollup) - shownInState.reduce((sum, [, rollup]) => sum + decisionVotesOf(rollup), 0);
    while (hiddenVotes > 0 && hiddenVotes < STATS_MIN_DECISION_VOTES && shownInState.length > 0) {
      const [key, rollup] = shownInState.shift()!;
      suppressedDistricts.add(key);
      hiddenVotes += decisionVotesOf(rollup);
    }
  }
  const byDistrict = Object.fromEntries(districtEntries.filter(([key]) => !suppressedDistricts.has(key)));

  const verified = stats.segments?.verified;
  const verifiedOutsideShownStates =
    (typeof verified?.decisionVotes === "number" ? verified.decisionVotes : 0) -
    Object.values(byState).reduce((sum, rollup) => sum + decisionVotesOf(rollup), 0);
  const segmentsPublishable =
    meetsSampleFloor(verified) &&
    !(verifiedOutsideShownStates > 0 && verifiedOutsideShownStates < STATS_MIN_DECISION_VOTES);
  const emptyBucket = withPercentages(createBucket());

  return {
    ...stats,
    segments: segmentsPublishable ? stats.segments : { verified: emptyBucket, selfAttested: emptyBucket },
    rollups: { byState, byDistrict },
  };
}

type ScopeWithSegments = {
  totals: VoteBucket;
  segments: { verified: VoteBucket; selfAttested: VoteBucket };
};

function equalWeightScope<T extends ScopeWithSegments>(scope: T): T {
  if (!scope || typeof scope !== "object") return scope;
  const segments = scope.segments;
  return {
    ...scope,
    totals: equalWeightBucket(scope.totals),
    segments:
      segments && typeof segments === "object"
        ? {
            ...segments,
            verified: equalWeightBucket(segments.verified),
            selfAttested: equalWeightBucket(segments.selfAttested),
          }
        : segments,
  };
}

function mapValues<T>(record: Record<string, T> | undefined, map: (value: T) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, map(value)]));
}

/**
 * 2C (INT-08): every weighted* field set to its plain counterpart, in totals, both segments and every
 * state and district rollup (and their segments). Neutralizes payloads cached at the old 1.25 weight
 * until the next vote on the bill recomputes them. Pure and idempotent.
 */
export function withEqualWeights(stats: BillStatsResponse): BillStatsResponse {
  const { totals, segments } = equalWeightScope({ totals: stats.totals, segments: stats.segments });
  return {
    ...stats,
    totals,
    segments,
    rollups: {
      ...stats.rollups,
      byState: mapValues(stats.rollups?.byState, equalWeightScope),
      byDistrict: mapValues(stats.rollups?.byDistrict, equalWeightScope),
    },
  };
}

function toVoteSplit(bucket: VoteSplit): VoteSplit {
  return {
    votes: bucket.votes,
    yea: bucket.yea,
    nay: bucket.nay,
    abstain: bucket.abstain,
    decisionVotes: bucket.decisionVotes,
    yeaPct: bucket.yeaPct,
  };
}

/**
 * The national comparison (2C): `allUsers` from totals, `verified` from segments.verified. The
 * verified split is withheld (left out, `verifiedWithheld: true`) when segments.verified has fewer
 * than STATS_MIN_DECISION_VOTES Yea + Nay votes, which also covers segments the sample floor emptied.
 * State and district rollups already count verified voters only, so the comparison is national only.
 */
export function buildStatsComparison(stats: Pick<BillStatsResponse, "totals" | "segments">): BillStatsComparison {
  const verifiedBucket = stats.segments?.verified;
  const verifiedWithheld = !meetsSampleFloor(verifiedBucket);
  return {
    allUsers: toVoteSplit(stats.totals),
    ...(verifiedWithheld ? {} : { verified: toVoteSplit(verifiedBucket) }),
    verifiedWithheld,
    minDecisionVotes: STATS_MIN_DECISION_VOTES,
  };
}

/** The stats with `comparison` (re)computed from their totals and verified segment. Pure and idempotent. */
export function withComparison(stats: BillStatsResponse): BillStatsResponse {
  return { ...stats, comparison: buildStatsComparison(stats) };
}

/**
 * What GET /bill-stats serves for any stats document (cached bill stats, companion group stats and
 * folds, empty stats), in order: the sample floor (harmless twice), equal weights, then the
 * comparison. Pure and idempotent.
 */
export function toServedStats(stats: BillStatsResponse): BillStatsResponse {
  return withComparison(withEqualWeights(applyStatsSampleFloor(stats)));
}

/** Bill stats with the sample floor applied: safe to cache and serve. */
export async function computeBillStats(params: ComputeBillStatsParams): Promise<BillStatsResponse> {
  return applyStatsSampleFloor(await computeRawBillStats(params));
}

/**
 * Feedback item attributes the stats computation reads; the bill-id GSI must project all of them.
 * effectiveWeight is not among them since 2C (every vote counts 1); the GSI projection stays ALL.
 * legacyDismiss (INT-11) marks a 1.0 or 1.1 Updates dismissal, which isCountedVote leaves out.
 */
export const BILL_STATS_VOTE_ATTRIBUTES = [
  "feedback",
  "constituentVerified",
  "resolvedState",
  "resolvedDistrict",
  "reasons",
  "adultEligible",
  LEGACY_DISMISS_ATTRIBUTE,
] as const;

type FeedbackItem = Record<string, AttributeValue | undefined>;

/**
 * True when a feedback item counts toward its bill's stats: an adult-eligible Yea, Nay or Abstain
 * that is not a 1.0 or 1.1 Updates dismissal (INT-11, legacyDismiss). A dismissal is not a vote, so
 * it is in no total, segment, rollup or "N people abstained", as it unlocks no results. A stream
 * INSERT of an item this rejects cannot change the stats: the item did not exist before and is not
 * counted now.
 */
export function isCountedVote(
  item:
    | {
        adultEligible?: { BOOL?: boolean };
        feedback?: { S?: string };
        [LEGACY_DISMISS_ATTRIBUTE]?: { BOOL?: boolean };
      }
    | null
    | undefined,
): boolean {
  if (!item) return false;
  if (item.adultEligible?.BOOL === false) return false;
  return unlocksResults(item);
}

export type BillStatsAccumulator = {
  /** Adds one feedback item (as the low-level DynamoDB client returns it); uncounted items are ignored. */
  add(item: FeedbackItem): void;
  /** The raw (unfloored) stats of every item added so far. */
  result(): BillStatsResponse;
};

/** Pure, order-independent fold of a bill's feedback items into its raw stats. */
export function createBillStatsAccumulator(billId: string): BillStatsAccumulator {
  const totals = createBucket();
  const verified = createBucket();
  const selfAttested = createBucket();
  const byState = new Map<string, ScopedBuckets>();
  const byDistrict = new Map<string, ScopedBuckets>();
  const yeaReasonCounts = new Map<string, number>();
  const nayReasonCounts = new Map<string, number>();
  const reasonMinCount = resolveReasonMinCount();

  const add = (item: FeedbackItem): void => {
    if (!isCountedVote(item)) return;
    const feedback = item.feedback!.S as string;

    // Every counted vote weighs 1 (2C, INT-08); a stored effectiveWeight (1.25 on older rows) is ignored.
    const isVerified = item.constituentVerified?.BOOL === true;
    const state = normalizeToken(item.resolvedState?.S);
    const district = normalizeToken(item.resolvedDistrict?.S);

    applyVote(totals, feedback);
    applyVote(isVerified ? verified : selfAttested, feedback);

    if (feedback === "Yea" || feedback === "Nay") {
      const map = feedback === "Yea" ? yeaReasonCounts : nayReasonCounts;
      const reasons = Array.isArray(item.reasons?.SS) ? item.reasons.SS : [];
      for (const reason of reasons) {
        if (typeof reason !== "string") continue;
        const normalizedReason = reason.trim();
        if (!normalizedReason) continue;
        map.set(normalizedReason, (map.get(normalizedReason) ?? 0) + 1);
      }
    }

    if (isVerified && state) {
      const stateBucket = byState.get(state) ?? createScopedBuckets();
      applyVoteToScope(stateBucket, feedback, isVerified);
      byState.set(state, stateBucket);
    }

    if (isVerified && state && district) {
      const districtKey = `${state}|${district}`;
      const districtBucket = byDistrict.get(districtKey) ?? createScopedBuckets();
      applyVoteToScope(districtBucket, feedback, isVerified);
      byDistrict.set(districtKey, districtBucket);
    }
  };

  const result = (): BillStatsResponse => {
    const byStateResponse = new Map<
      string,
      {
        state: string;
        totals: BucketWithPercentages;
        segments: {
          verified: BucketWithPercentages;
          selfAttested: BucketWithPercentages;
        };
      }
    >();
    for (const [state, bucket] of byState.entries()) {
      byStateResponse.set(state, {
        state,
        totals: withPercentages(bucket.totals),
        segments: {
          verified: withPercentages(bucket.verified),
          selfAttested: withPercentages(bucket.selfAttested),
        },
      });
    }

    const byDistrictResponse = new Map<
      string,
      {
        state: string;
        district: string;
        totals: BucketWithPercentages;
        segments: {
          verified: BucketWithPercentages;
          selfAttested: BucketWithPercentages;
        };
      }
    >();
    for (const [districtKey, bucket] of byDistrict.entries()) {
      const [state, district] = districtKey.split("|");
      byDistrictResponse.set(districtKey, {
        state,
        district,
        totals: withPercentages(bucket.totals),
        segments: {
          verified: withPercentages(bucket.verified),
          selfAttested: withPercentages(bucket.selfAttested),
        },
      });
    }

    return {
      billId,
      generatedAt: new Date().toISOString(),
      totals: withPercentages(totals),
      segments: {
        verified: withPercentages(verified),
        selfAttested: withPercentages(selfAttested),
      },
      rollups: {
        byState: toSortedObject(byStateResponse),
        byDistrict: toSortedObject(byDistrictResponse),
      },
      reasonBreakdown: {
        minCount: reasonMinCount,
        yea: {
          voteCount: totals.yea,
          reasons: buildReasonBuckets(yeaReasonCounts, totals.yea, reasonMinCount),
        },
        nay: {
          voteCount: totals.nay,
          reasons: buildReasonBuckets(nayReasonCounts, totals.nay, reasonMinCount),
        },
      },
    };
  };

  return { add, result };
}

/** The bill-id GSI query of one bill's vote rows. */
type BillVoteRowsQuery = {
  db: Pick<DynamoDBClient, "send">;
  tableName: string;
  sortKey: string;
  billIdIndexName: string;
  billId: string;
};

/**
 * Hands every vote row of the bill to `visit`, read through the bill-id GSI one 1 MB page at a time
 * with BILL_STATS_VOTE_ATTRIBUTES plus `extraAttributes` (placeholder to attribute name). With
 * `maxRows`, stops after the page that takes the rows read past it and answers false; true once
 * every row has been read.
 */
async function forEachBillVoteRow(
  { db, tableName, sortKey, billIdIndexName, billId }: BillVoteRowsQuery,
  visit: (item: FeedbackItem) => void,
  { extraAttributes = {}, maxRows }: { extraAttributes?: Record<string, string>; maxRows?: number } = {},
): Promise<boolean> {
  const projection = [...BILL_STATS_VOTE_ATTRIBUTES, ...Object.keys(extraAttributes)].join(", ");
  let rowsRead = 0;
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await db.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: billIdIndexName,
        KeyConditionExpression: "#billId = :billId",
        ExpressionAttributeNames: { "#billId": sortKey, ...extraAttributes },
        ExpressionAttributeValues: { ":billId": { S: billId } },
        ProjectionExpression: projection,
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of result.Items ?? []) visit(item);
    rowsRead += result.Items?.length ?? 0;
    if (maxRows !== undefined && rowsRead > maxRows) return false;

    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return true;
}

/**
 * Bill stats before the sample floor, including thin state, district and verified buckets.
 * Never serve or cache this directly; writeCachedStats floors it before storing.
 *
 * Reads every vote for the bill through the bill-id GSI, one 1 MB page at a time, asking only for
 * the attributes the fold uses. (A query is billed on the size of the index items it reads, so the
 * read units only drop further if the GSI itself projects just BILL_STATS_VOTE_ATTRIBUTES.)
 */
export async function computeRawBillStats({
  db,
  tableName,
  sortKey,
  billIdIndexName,
  billId,
}: ComputeBillStatsParams): Promise<BillStatsResponse> {
  const accumulator = createBillStatsAccumulator(billId);
  await forEachBillVoteRow({ db, tableName, sortKey, billIdIndexName, billId }, accumulator.add);
  return accumulator.result();
}

type ComputeFreshBillStatsParams = BillVoteRowsQuery & {
  /** The feedback table's partition key (the user id); the GSI projects it like every key attribute. */
  userIdAttribute: string;
  /** Rows whose votedAt (ms) is later than this are listed in recentVotes. */
  recentAfterMs: number;
  /** Rows to read at most (give or take one page): a bill with more gets null. */
  maxRows: number;
};

export type FreshBillStats = {
  /** The bill's stats as billStatsAggregator would store them now: the same fold and sample floor. */
  stats: BillStatsResponse;
  /**
   * User id to votedAt (ms) of every row read whose votedAt is later than recentAfterMs. The GSI is
   * eventually consistent and shows rows in no particular order, so a fold read right after a vote can
   * miss it, and one row read says nothing of another: these are the recent votes the fold is known
   * to hold.
   */
  recentVotes: Map<string, number>;
};

/**
 * S1: a bill's stats folded now from the bill-id GSI, for GET /bill-stats to serve without writing:
 * computeRawBillStats' query and accumulator, then applyStatsSampleFloor, as writeCachedStats stores
 * them. Also reads the user id and votedAt of each row, only to list the recent ones it held. Null
 * when the bill has more than maxRows rows (it stops reading there).
 */
export async function computeFreshBillStats({
  userIdAttribute,
  recentAfterMs,
  maxRows,
  ...query
}: ComputeFreshBillStatsParams): Promise<FreshBillStats | null> {
  const accumulator = createBillStatsAccumulator(query.billId);
  const recentVotes = new Map<string, number>();
  const complete = await forEachBillVoteRow(
    query,
    (item) => {
      accumulator.add(item);
      const userId = item[userIdAttribute]?.S;
      const votedAtMs = Date.parse(item.votedAt?.S ?? "");
      if (userId && votedAtMs > recentAfterMs) recentVotes.set(userId, votedAtMs);
    },
    { extraAttributes: { "#userId": userIdAttribute, "#votedAt": "votedAt" }, maxRows },
  );
  if (!complete) return null;
  return { stats: applyStatsSampleFloor(accumulator.result()), recentVotes };
}

type CompanionFoldOptions = {
  /** Attributes to project besides BILL_STATS_VOTE_ATTRIBUTES and the user id (placeholder to name). */
  extraAttributes?: Record<string, string>;
  /** Rows to read at most across all members (give or take one page): past it the fold stops. */
  maxRows?: number;
  /** Called with each row the group counts as its user's vote: their first row, in member order, that holds one. */
  onGroupVote?: (userId: string, item: FeedbackItem) => void;
};

/**
 * Adds a companion group's votes to `accumulator`, one per person (computeRawCompanionStats gives the
 * rule). Answers false when it stopped past `maxRows`, true once every member's rows were read.
 */
async function foldCompanionVotes(
  { db, tableName, userIdAttribute, sortKey, billIdIndexName, memberGuids }: ComputeCompanionStatsParams,
  accumulator: BillStatsAccumulator,
  { extraAttributes = {}, maxRows, onGroupVote }: CompanionFoldOptions = {},
): Promise<boolean> {
  const usersWithVote = new Set<string>();
  let rowsRead = 0;

  for (const memberGuid of new Set(memberGuids)) {
    // A user has one row per bill, so users found on this member are only checked against earlier ones.
    const usersOnMember: string[] = [];
    const complete = await forEachBillVoteRow(
      { db, tableName, sortKey, billIdIndexName, billId: memberGuid },
      (item) => {
        rowsRead += 1;
        const userId = item[userIdAttribute]?.S;
        if (userId && usersWithVote.has(userId)) return;
        accumulator.add(item);
        if (userId && unlocksResults(item)) {
          usersOnMember.push(userId);
          onGroupVote?.(userId, item);
        }
      },
      {
        extraAttributes: { "#userId": userIdAttribute, ...extraAttributes },
        // The rows left of the budget: the fold stops after the page that takes the members together past it.
        ...(maxRows === undefined ? {} : { maxRows: maxRows - rowsRead }),
      },
    );
    if (!complete) return false;
    for (const userId of usersOnMember) usersWithVote.add(userId);
  }
  return true;
}

/**
 * The raw (unfloored) stats of a companion group (APPF-23): the votes on every member, one per
 * person. Members are read in order, primary first, through the bill-id GSI (with the user id added
 * to the projection); a user who holds a vote (any valid Yea, Nay or Abstain row) on an earlier
 * member is skipped on the later ones. So the primary's row wins and a vote on the other member
 * alone still counts, as in civic score. A 1.0 or 1.1 dismissal (INT-11, legacyDismiss) is not a
 * vote: it is not counted and does not hide the user's vote on a later member, as in the results
 * gate. Only the user ids already counted are kept in memory.
 * Never serve or cache this directly; writeCachedStats floors it before storing.
 */
export async function computeRawCompanionStats(params: ComputeCompanionStatsParams): Promise<BillStatsResponse> {
  const accumulator = createBillStatsAccumulator(params.statsKey);
  await foldCompanionVotes(params, accumulator);
  return accumulator.result();
}

type ComputeFreshCompanionStatsParams = ComputeCompanionStatsParams & {
  /** Group votes whose votedAt (ms) is later than this are listed in recentVotes. */
  recentAfterMs: number;
  /** Rows to read at most across the members (give or take one page): a group with more gets null. */
  maxRows: number;
};

/**
 * REL-48 (S1 for scope=companions): a companion group's stats folded now from the bill-id GSI, for
 * GET /bill-stats to serve without writing: computeRawCompanionStats' reads and rule (one vote per
 * person, the primary's row wins, a dismissal hides nothing), then applyStatsSampleFloor, as
 * billStatsAggregator stores the group. recentVotes lists, by user id, the votedAt of each recent row
 * the group counts as its user's vote (a row skipped for the user's vote on an earlier member is not
 * listed: it is not in the stats). Null when the members hold more than maxRows rows between them
 * (it stops reading there).
 */
export async function computeFreshCompanionStats({
  recentAfterMs,
  maxRows,
  ...params
}: ComputeFreshCompanionStatsParams): Promise<FreshBillStats | null> {
  const accumulator = createBillStatsAccumulator(params.statsKey);
  const recentVotes = new Map<string, number>();
  const complete = await foldCompanionVotes(params, accumulator, {
    extraAttributes: { "#votedAt": "votedAt" },
    maxRows,
    onGroupVote: (userId, item) => {
      const votedAtMs = Date.parse(item.votedAt?.S ?? "");
      if (votedAtMs > recentAfterMs) recentVotes.set(userId, votedAtMs);
    },
  });
  if (!complete) return null;
  return { stats: applyStatsSampleFloor(accumulator.result()), recentVotes };
}
