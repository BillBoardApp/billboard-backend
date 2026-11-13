import { QueryCommand, DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { readFile } from "node:fs/promises";
import { CIVIC_PROFILE_AXES, CivicProfileAxis } from "../src/models/bill";
import { computeMemberCivicProfile, MemberEvidenceRow, MemberEvidenceType } from "../src/shared/memberCivicProfile";

type AxisExpectation = {
  min?: number;
  max?: number;
};

type BenchmarkMember = {
  bioguideId: string;
  label?: string;
  expected?: Partial<Record<CivicProfileAxis, AxisExpectation>>;
};

type BenchmarkConfig = {
  members: BenchmarkMember[];
};

const VOTE_TABLE_NAME = process.env.VOTE_PROFILE_TABLE_NAME ?? "CongressMemberVoteProfiles";
const VOTE_PARTITION_KEY = process.env.VOTE_PROFILE_PRIMARY_KEY ?? "bioguideId";
const LEGISLATIVE_TABLE_NAME = process.env.LEGISLATIVE_PROFILE_TABLE_NAME ?? "CongressMemberLegislativeProfiles";
const LEGISLATIVE_PARTITION_KEY = process.env.LEGISLATIVE_PROFILE_PRIMARY_KEY ?? "bioguideId";

const db = new DynamoDBClient({});

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const parseVotePosition = (value: unknown): "Yea" | "Nay" | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  return null;
};

const parseEvidenceType = (value: unknown): MemberEvidenceType | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "sponsor") return "sponsor";
  if (normalized === "cosponsor") return "cosponsor";
  if (normalized === "voteyea") return "voteYea";
  if (normalized === "votenay") return "voteNay";
  return null;
};

const parseCivicProfileMap = (mapAttr: AttributeValue | undefined): Record<string, number> | null => {
  const m = mapAttr?.M;
  if (!m || typeof m !== "object") return null;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(m)) {
    // A value without N parses to NaN and is skipped.
    const numeric = parseFloat(val?.N as string);
    if (!Number.isNaN(numeric)) result[key] = numeric;
  }
  return Object.keys(result).length > 0 ? result : null;
};

const queryRows = async (
  bioguideId: string,
  tableName: string,
  partitionKey: string,
  parseItem: (item: Record<string, AttributeValue>) => MemberEvidenceRow | null,
): Promise<MemberEvidenceRow[]> => {
  const rows: MemberEvidenceRow[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await db.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": partitionKey, "#sk": "billGuid" },
        ExpressionAttributeValues: { ":pk": { S: bioguideId } },
        ProjectionExpression: "#sk, evidenceType, votePosition, occurredAt, votedAt, civicProfile",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const parsed = parseItem(item);
      if (parsed) rows.push(parsed);
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return rows;
};

const queryMemberEvidence = async (bioguideId: string): Promise<MemberEvidenceRow[]> => {
  const [voteRows, legislativeRows] = await Promise.all([
    queryRows(bioguideId, VOTE_TABLE_NAME, VOTE_PARTITION_KEY, (item) => {
      const votePosition = parseVotePosition(item?.votePosition?.S);
      const occurredAt = toTrimmedString(item?.occurredAt?.S || item?.votedAt?.S);
      const civicProfile = parseCivicProfileMap(item?.civicProfile);
      if (!votePosition || !occurredAt || !civicProfile) return null;
      return {
        billGuid: toTrimmedString(item?.billGuid?.S),
        evidenceType: votePosition === "Yea" ? "voteYea" : "voteNay",
        occurredAt,
        civicProfile,
      };
    }),
    queryRows(bioguideId, LEGISLATIVE_TABLE_NAME, LEGISLATIVE_PARTITION_KEY, (item) => {
      const evidenceType = parseEvidenceType(item?.evidenceType?.S);
      const occurredAt = toTrimmedString(item?.occurredAt?.S);
      const civicProfile = parseCivicProfileMap(item?.civicProfile);
      if (
        !evidenceType ||
        (evidenceType !== "sponsor" && evidenceType !== "cosponsor") ||
        !occurredAt ||
        !civicProfile
      ) {
        return null;
      }
      return {
        billGuid: toTrimmedString(item?.billGuid?.S),
        evidenceType,
        occurredAt,
        civicProfile,
      };
    }),
  ]);
  return [...voteRows, ...legislativeRows];
};

const parseArgs = async (): Promise<{ config: BenchmarkConfig; json: boolean }> => {
  const args = process.argv.slice(2);
  const membersArg = args.find((arg) => arg.startsWith("--members="));
  const benchmarkArg = args.find((arg) => arg.startsWith("--benchmark="));
  const json = args.includes("--json");

  if (benchmarkArg) {
    const path = benchmarkArg.slice("--benchmark=".length);
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(raw)) return { config: { members: raw }, json };
    return { config: raw as BenchmarkConfig, json };
  }

  if (membersArg) {
    const members = membersArg
      .slice("--members=".length)
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .map((bioguideId) => ({ bioguideId }));
    return { config: { members }, json };
  }

  throw new Error(
    "Usage: npm run benchmark:civic-profiles -- --members=A000001,B000002 OR --benchmark=path/to/benchmark.json",
  );
};

const scoreText = (score: number | undefined): string => (score === undefined ? "n/a" : score.toFixed(3));

const expectationWarnings = (member: BenchmarkMember, axes: Partial<Record<CivicProfileAxis, number>>): string[] => {
  const expected = member.expected ?? {};
  const warnings: string[] = [];
  for (const axis of CIVIC_PROFILE_AXES) {
    const expectation = expected[axis];
    if (!expectation) continue;
    const score = axes[axis];
    if (score === undefined) {
      warnings.push(`${axis}: missing score`);
      continue;
    }
    if (expectation.min !== undefined && score < expectation.min) {
      warnings.push(`${axis}: ${score.toFixed(3)} below ${expectation.min}`);
    }
    if (expectation.max !== undefined && score > expectation.max) {
      warnings.push(`${axis}: ${score.toFixed(3)} above ${expectation.max}`);
    }
  }
  return warnings;
};

const main = async () => {
  const { config, json } = await parseArgs();
  const rows = [];
  let failures = 0;

  for (const member of config.members) {
    const bioguideId = member.bioguideId.trim().toUpperCase();
    const profile = computeMemberCivicProfile(await queryMemberEvidence(bioguideId));
    const warnings = expectationWarnings(member, profile.axes);
    failures += warnings.length > 0 ? 1 : 0;
    rows.push({
      bioguideId,
      label: member.label ?? "",
      isReady: profile.isReady,
      weightedEvidence: profile.diagnostics.weightedEvidenceUsed,
      axesReady: profile.diagnostics.axesWithSufficientSignal,
      votesUsed: profile.votesUsed,
      sponsoredBillsUsed: profile.sponsoredBillsUsed,
      cosponsoredBillsUsed: profile.cosponsoredBillsUsed,
      axes: profile.axes,
      warnings,
    });
  }

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  } else {
    const axisHeaders = CIVIC_PROFILE_AXES.map((axis) => axis.replace(/[a-z]+Vs/g, ""));
    console.log(
      [
        "bioguideId",
        "label",
        "ready",
        "weighted",
        "axes",
        "votes",
        "sponsor",
        "cosponsor",
        ...axisHeaders,
        "warnings",
      ].join("\t"),
    );
    for (const row of rows) {
      console.log(
        [
          row.bioguideId,
          row.label,
          String(row.isReady),
          row.weightedEvidence.toFixed(1),
          String(row.axesReady),
          String(row.votesUsed),
          String(row.sponsoredBillsUsed),
          String(row.cosponsoredBillsUsed),
          ...CIVIC_PROFILE_AXES.map((axis) => scoreText(row.axes[axis])),
          row.warnings.join("; "),
        ].join("\t"),
      );
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
