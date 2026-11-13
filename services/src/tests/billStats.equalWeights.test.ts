import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyTestEnv } from "./fixtures/env";

// 2C (INT-08, C2 3.1): every vote counts 1, and GET /bill-stats serves the comparison block.
// The old weight variables are set on purpose: they must no longer change anything.
const restoreEnv = applyTestEnv({ VERIFIED_VOTE_WEIGHT: "1.25", SELF_ATTESTED_VOTE_WEIGHT: "1.0" });

const billStats = require("../shared/billStats");
const {
  BILL_STATS_VOTE_ATTRIBUTES,
  STATS_MIN_DECISION_VOTES,
  buildStatsComparison,
  createBillStatsAccumulator,
  createEmptyBillStats,
  toServedStats,
  withComparison,
  withEqualWeights,
} = billStats;

afterAll(() => restoreEnv());

const CONTRACTS_DIR = join(__dirname, "../../../contracts");
/** The subset of JSON Schema the OpenAPI components use, as far as the walk below reads it. */
interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  not?: JsonSchema;
}

const openapi = JSON.parse(readFileSync(join(CONTRACTS_DIR, "openapi/user-api.v1.json"), "utf8")) as {
  components: { schemas: Record<string, JsonSchema> };
};
const statsFixture = JSON.parse(readFileSync(join(CONTRACTS_DIR, "fixtures/openapi/BillStats.valid.json"), "utf8"));

const WEIGHTED_TO_PLAIN: Record<string, string> = {
  weightedVotes: "votes",
  weightedYea: "yea",
  weightedNay: "nay",
  weightedAbstain: "abstain",
  weightedDecisionVotes: "decisionVotes",
  weightedYeaPct: "yeaPct",
};

/** A served bucket as the stats stored before 2C hold it: weighted at 1.25 per verified vote. */
const weightedBucket = (yea: number, nay: number, abstain: number, verifiedShare: { yea: number; nay: number }) => {
  const decisionVotes = yea + nay;
  const weightedYea = yea + 0.25 * verifiedShare.yea;
  const weightedNay = nay + 0.25 * verifiedShare.nay;
  return {
    votes: yea + nay + abstain,
    yea,
    nay,
    abstain,
    decisionVotes,
    yeaPct: decisionVotes > 0 ? Math.round((yea / decisionVotes) * 100 * 10000) / 10000 : null,
    weightedVotes: yea + nay + abstain + 0.25 * (verifiedShare.yea + verifiedShare.nay),
    weightedYea,
    weightedNay,
    weightedAbstain: abstain,
    weightedDecisionVotes: weightedYea + weightedNay,
    weightedYeaPct:
      weightedYea + weightedNay > 0
        ? Math.round((weightedYea / (weightedYea + weightedNay)) * 100 * 10000) / 10000
        : null,
  };
};

/** A VoteBucket, read field by field. */
type VoteBucketFields = Record<string, unknown>;

/** The parts of a BillStats document the equal-weights check walks. */
interface StatsDocument {
  totals: VoteBucketFields;
  segments: { verified: VoteBucketFields; selfAttested: VoteBucketFields };
  rollups: Record<
    string,
    Record<
      string,
      { totals: VoteBucketFields; segments: { verified: VoteBucketFields; selfAttested: VoteBucketFields } }
    >
  >;
}

/** Every VoteBucket of a stats document, with its path. */
const bucketsOf = (stats: StatsDocument): Array<[string, VoteBucketFields]> => {
  const buckets: Array<[string, VoteBucketFields]> = [
    ["totals", stats.totals],
    ["segments.verified", stats.segments.verified],
    ["segments.selfAttested", stats.segments.selfAttested],
  ];
  for (const [scope, rollups] of Object.entries(stats.rollups)) {
    for (const [key, rollup] of Object.entries(rollups)) {
      buckets.push([`rollups.${scope}.${key}.totals`, rollup.totals]);
      buckets.push([`rollups.${scope}.${key}.segments.verified`, rollup.segments.verified]);
      buckets.push([`rollups.${scope}.${key}.segments.selfAttested`, rollup.segments.selfAttested]);
    }
  }
  return buckets;
};

const expectEqualWeights = (stats: StatsDocument) => {
  for (const [path, bucket] of bucketsOf(stats)) {
    for (const [weighted, plain] of Object.entries(WEIGHTED_TO_PLAIN)) {
      expect({ path, field: weighted, value: bucket[weighted] }).toEqual({
        path,
        field: weighted,
        value: bucket[plain],
      });
    }
  }
};

/** A payload cached before 2C: 8 verified (at 1.25) and 6 self-attested votes, with CA rollups. */
const cachedAtOldWeights = () => ({
  billId: "BILLS-119hr1",
  generatedAt: "2026-09-30T00:00:00.000Z",
  totals: weightedBucket(7, 5, 2, { yea: 5, nay: 2 }),
  segments: {
    verified: weightedBucket(5, 2, 1, { yea: 5, nay: 2 }),
    selfAttested: weightedBucket(2, 3, 1, { yea: 0, nay: 0 }),
  },
  rollups: {
    byState: {
      CA: {
        state: "CA",
        totals: weightedBucket(5, 2, 1, { yea: 5, nay: 2 }),
        segments: {
          verified: weightedBucket(5, 2, 1, { yea: 5, nay: 2 }),
          selfAttested: weightedBucket(0, 0, 0, { yea: 0, nay: 0 }),
        },
      },
    },
    byDistrict: {
      "CA|12": {
        state: "CA",
        district: "CA-12",
        totals: weightedBucket(5, 2, 1, { yea: 5, nay: 2 }),
        segments: {
          verified: weightedBucket(5, 2, 1, { yea: 5, nay: 2 }),
          selfAttested: weightedBucket(0, 0, 0, { yea: 0, nay: 0 }),
        },
      },
    },
  },
  reasonBreakdown: { minCount: 5, yea: { voteCount: 7, reasons: [] }, nay: { voteCount: 5, reasons: [] } },
});

/** Stats whose verified segment has `yea` + `nay` decision votes and `abstain` abstentions. */
const withVerified = (yea: number, nay: number, abstain = 0) => {
  const accumulator = createBillStatsAccumulator("BILLS-119s9");
  const add = (feedback: string, verified: boolean) =>
    accumulator.add({
      feedback: { S: feedback },
      constituentVerified: { BOOL: verified },
      // No state, so the floor's state rule plays no part here.
    });
  for (let i = 0; i < yea; i += 1) add("Yea", true);
  for (let i = 0; i < nay; i += 1) add("Nay", true);
  for (let i = 0; i < abstain; i += 1) add("Abstain", true);
  for (let i = 0; i < 6; i += 1) add(i < 4 ? "Yea" : "Nay", false);
  return accumulator.result();
};

// ─── A minimal JSON Schema walk over the OpenAPI components (the subset BillStats uses) ──────────

const resolve = (schema: JsonSchema | undefined): JsonSchema | undefined =>
  schema?.$ref ? resolve(openapi.components.schemas[schema.$ref.replace("#/components/schemas/", "")]) : schema;

const typeMatches = (type: string, value: unknown): boolean => {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
};

const schemaErrors = (rawSchema: JsonSchema | undefined, value: unknown, path = "$"): string[] => {
  const schema = resolve(rawSchema);
  if (!schema) return [];
  const errors: string[] = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type: string) => typeMatches(type, value))) return [`${path}: not ${types.join(" or ")}`];
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: not ${schema.const}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: under ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: over ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(schema.properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errors.push(...schemaErrors(schema.additionalProperties, child, `${path}.${key}`));
    }
  }
  if (schema.if) {
    const branch = schemaErrors(schema.if, value, path).length === 0 ? schema.then : schema.else;
    if (branch) errors.push(...schemaErrors(branch, value, path));
  }
  if (schema.not && schemaErrors(schema.not, value, path).length === 0)
    errors.push(`${path}: matches a forbidden shape`);
  return errors;
};

const billStatsErrors = (body: unknown) => schemaErrors({ $ref: "#/components/schemas/BillStats" }, body);

describe("2C: aggregation counts every vote once", () => {
  it("ignores effectiveWeight, even at 1.25 with the old weight variables set", () => {
    const accumulator = createBillStatsAccumulator("BILLS-119hr2");
    const vote = (feedback: string, verified: boolean, weight: string) => ({
      feedback: { S: feedback },
      constituentVerified: { BOOL: verified },
      effectiveWeight: { N: weight },
      ...(verified ? { resolvedState: { S: "CA" }, resolvedDistrict: { S: "CA-12" } } : {}),
    });
    // 5 verified Yea at 1.25 against 5 self-attested Nay at 1.0: weighted, Yea would be 55.5556%.
    for (let i = 0; i < 5; i += 1) accumulator.add(vote("Yea", true, "1.25"));
    for (let i = 0; i < 5; i += 1) accumulator.add(vote("Nay", false, "1.0"));
    accumulator.add(vote("Abstain", true, "1.25"));
    accumulator.add(vote("Nay", false, "NaN"));

    const stats = accumulator.result();

    expect(stats.totals).toEqual({
      votes: 12,
      yea: 5,
      nay: 6,
      abstain: 1,
      decisionVotes: 11,
      yeaPct: 45.4545,
      weightedVotes: 12,
      weightedYea: 5,
      weightedNay: 6,
      weightedAbstain: 1,
      weightedDecisionVotes: 11,
      weightedYeaPct: 45.4545,
    });
    expect(stats.segments.verified).toMatchObject({ votes: 6, yea: 5, weightedVotes: 6, weightedYeaPct: 100 });
    expect(stats.rollups.byState.CA.totals).toMatchObject({ votes: 6, weightedVotes: 6, weightedYea: 5 });
    expectEqualWeights(stats);
  });

  it("no longer reads effectiveWeight from the feedback rows", () => {
    expect(BILL_STATS_VOTE_ATTRIBUTES).not.toContain("effectiveWeight");
    expect([...BILL_STATS_VOTE_ATTRIBUTES]).toEqual([
      "feedback",
      "constituentVerified",
      "resolvedState",
      "resolvedDistrict",
      "reasons",
      "adultEligible",
      "legacyDismiss",
    ]);
  });

  it("drops the weight helpers and constants", () => {
    expect(billStats).not.toHaveProperty("VERIFIED_VOTE_WEIGHT");
    expect(billStats).not.toHaveProperty("SELF_ATTESTED_VOTE_WEIGHT");
    expect(billStats).not.toHaveProperty("defaultWeightForVerification");
  });
});

describe("2C: toServedStats", () => {
  it("sets every weighted field of a payload cached at 1.25 to its plain value, in every bucket", () => {
    const cached = cachedAtOldWeights();
    expect(cached.totals.weightedYeaPct).not.toBe(cached.totals.yeaPct);

    const served = toServedStats(cached);

    expectEqualWeights(served);
    expect(served.totals).toEqual({
      votes: 14,
      yea: 7,
      nay: 5,
      abstain: 2,
      decisionVotes: 12,
      yeaPct: 58.3333,
      weightedVotes: 14,
      weightedYea: 7,
      weightedNay: 5,
      weightedAbstain: 2,
      weightedDecisionVotes: 12,
      weightedYeaPct: 58.3333,
    });
    expect(Object.keys(served.rollups.byState)).toEqual(["CA"]);
    expect(Object.keys(served.rollups.byDistrict)).toEqual(["CA|12"]);
    expect(served.rollups.byDistrict["CA|12"]).toMatchObject({ state: "CA", district: "CA-12" });
    expect(served.reasonBreakdown).toEqual(cached.reasonBreakdown);
    expect(served.generatedAt).toBe(cached.generatedAt);
  });

  it("adds the national comparison from totals and the verified segment", () => {
    expect(toServedStats(cachedAtOldWeights()).comparison).toEqual({
      allUsers: { votes: 14, yea: 7, nay: 5, abstain: 2, decisionVotes: 12, yeaPct: 58.3333 },
      verified: { votes: 8, yea: 5, nay: 2, abstain: 1, decisionVotes: 7, yeaPct: 71.4286 },
      verifiedWithheld: false,
      minDecisionVotes: 5,
    });
  });

  it("is idempotent and leaves its input unchanged", () => {
    const cached = cachedAtOldWeights();
    const snapshot = JSON.parse(JSON.stringify(cached));

    const once = toServedStats(cached);
    expect(toServedStats(once)).toEqual(once);
    expect(withEqualWeights(once)).toEqual(once);
    expect(withComparison(once)).toEqual(once);
    expect(cached).toEqual(snapshot);
  });

  it("applies the sample floor first", () => {
    const cached = cachedAtOldWeights();
    cached.rollups.byState.CA.totals = weightedBucket(2, 1, 0, { yea: 2, nay: 1 });
    cached.rollups.byDistrict["CA|12"].totals = weightedBucket(2, 1, 0, { yea: 2, nay: 1 });

    const served = toServedStats(cached);

    expect(served.rollups).toEqual({ byState: {}, byDistrict: {} });
  });

  it.each([
    ["no verified votes", 0, 0, 0],
    ["4 verified decision votes", 3, 1, 0],
    ["4 verified decision votes and 3 abstentions", 4, 0, 3],
  ])("withholds the verified split with %s", (_label, yea, nay, abstain) => {
    const comparison = toServedStats(withVerified(yea, nay, abstain)).comparison;

    expect(comparison).toEqual({
      allUsers: expect.objectContaining({ yea: yea + 4, nay: nay + 2 }),
      verifiedWithheld: true,
      minDecisionVotes: STATS_MIN_DECISION_VOTES,
    });
    expect(comparison).not.toHaveProperty("verified");
  });

  it("shows the verified split from 5 verified decision votes", () => {
    const comparison = toServedStats(withVerified(4, 1, 2)).comparison;

    expect(comparison).toEqual({
      allUsers: { votes: 13, yea: 8, nay: 3, abstain: 2, decisionVotes: 11, yeaPct: 72.7273 },
      verified: { votes: 7, yea: 4, nay: 1, abstain: 2, decisionVotes: 5, yeaPct: 80 },
      verifiedWithheld: false,
      minDecisionVotes: 5,
    });
  });

  it("withholds the verified split when the floor's second rule empties the segments (at least 5 verified)", () => {
    // 7 verified decision votes, but CA shows 5: verified minus the shown states would expose 2.
    const accumulator = createBillStatsAccumulator("BILLS-119hr3");
    const add = (feedback: string, state?: string) =>
      accumulator.add({
        feedback: { S: feedback },
        constituentVerified: { BOOL: true },
        ...(state ? { resolvedState: { S: state } } : {}),
      });
    for (let i = 0; i < 4; i += 1) add("Yea", "CA");
    add("Nay", "CA");
    add("Yea", "WY");
    add("Nay", "WY");
    const raw = accumulator.result();
    expect(raw.segments.verified.decisionVotes).toBe(7);

    const served = toServedStats(raw);

    expect(served.segments.verified.decisionVotes).toBe(0);
    expect(served.comparison).toEqual({
      allUsers: { votes: 7, yea: 5, nay: 2, abstain: 0, decisionVotes: 7, yeaPct: 71.4286 },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
  });

  it("gives empty stats a comparison with the verified split withheld", () => {
    const served = toServedStats(createEmptyBillStats("BILLS-119hr4"));

    expect(served.comparison).toEqual({
      allUsers: { votes: 0, yea: 0, nay: 0, abstain: 0, decisionVotes: 0, yeaPct: null },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
    expectEqualWeights(served);
  });

  it("builds the comparison from the plain split only", () => {
    const comparison = buildStatsComparison(toServedStats(cachedAtOldWeights()));

    for (const split of [comparison.allUsers, comparison.verified]) {
      expect(Object.keys(split).sort()).toEqual(["abstain", "decisionVotes", "nay", "votes", "yea", "yeaPct"]);
    }
  });
});

describe("2C: served bodies match the contract (C2 4.2)", () => {
  it("reproduces the contract's BillStats sample, comparison included", () => {
    const { comparison, ...withoutComparison } = statsFixture;

    const served = toServedStats(withoutComparison);

    expect(served.comparison).toEqual(comparison);
    expect(served).toEqual(statsFixture);
  });

  it.each([
    ["a payload cached at 1.25", () => cachedAtOldWeights()],
    ["empty stats", () => createEmptyBillStats("BILLS-119hr5")],
    ["a withheld verified split", () => withVerified(3, 1)],
    ["a shown verified split", () => withVerified(4, 1, 2)],
  ])("serves %s as a valid BillStats", (_label, make) => {
    expect(billStatsErrors(toServedStats(make()))).toEqual([]);
  });

  it("the schema walk rejects what the contract rejects", () => {
    const served = toServedStats(withVerified(4, 1));
    const verifiedWhileWithheld = { ...served, comparison: { ...served.comparison, verifiedWithheld: true } };
    const extraField = { ...served, totals: { ...served.totals, weight: 1 } };
    const missingWeighted = { ...served, totals: { ...served.totals, weightedYeaPct: undefined } };
    delete missingWeighted.totals.weightedYeaPct;

    expect(billStatsErrors(verifiedWhileWithheld)).not.toEqual([]);
    expect(billStatsErrors(extraField)).toEqual(["$.totals: unexpected weight"]);
    expect(billStatsErrors(missingWeighted)).toEqual(["$.totals: missing weightedYeaPct"]);
  });
});
