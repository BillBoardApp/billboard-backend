#!/usr/bin/env node

// App Attest readiness report (INT-04; C3 WP-C3a and the adoption checks of C3 8.4 before enforce).
// Read-only: it only Scans the AppAttest and UserFeedback tables and never writes. It prints
//   - keys by environment and by status;
//   - accounts per key (accountCount) and sign-ups per key (signupCount);
//   - vote outcomes (the vote row's appAttest attribute) over the last --vote-days (default 14);
//   - accounts that voted in the last --active-days (default 30) with no binding to any key;
//   - the two table-based vote-enforcement checks of C3 8.4: at least 95% of recent votes are
//     `valid`, and every recently active account has a binding.
// The sign-up checks of C3 8.4 come from the PreSignUpCheck logs, not from these tables.
//
// Usage (from services/): npm run report:app-attest [-- --json] [-- --vote-days 14 --active-days 30]
// Environment: AWS_REGION (us-east-1), APP_ATTEST_TABLE_NAME (AppAttest), FEEDBACK_TABLE_NAME
// (UserFeedback), FEEDBACK_PARTITION_KEY (userId). Output has counts only, never a user or key ID.

import { DynamoDBClient, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";

export interface ReportConfig {
  region: string;
  appAttestTableName: string;
  feedbackTableName: string;
  feedbackPartitionKey: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ReportConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  appAttestTableName: env.APP_ATTEST_TABLE_NAME || "AppAttest",
  feedbackTableName: env.FEEDBACK_TABLE_NAME || "UserFeedback",
  feedbackPartitionKey: env.FEEDBACK_PARTITION_KEY || "userId",
});

export interface CliOptions {
  help: boolean;
  json: boolean;
  voteDays: number;
  activeDays: number;
}

export const USAGE = `Usage: npm run report:app-attest [-- --json] [-- --vote-days N] [-- --active-days N]
Read-only App Attest readiness report (scans AppAttest and UserFeedback; writes nothing).`;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, json: false, voteDays: 14, activeDays: 30 };
  const readDays = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 1 || value > 400)
      throw new Error(`${flag} needs a whole number from 1 to 400`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--vote-days") options.voteDays = readDays(arg, argv[(index += 1)]);
    else if (arg === "--active-days") options.activeDays = readDays(arg, argv[(index += 1)]);
    else throw new Error(`Unknown argument ${arg}\n${USAGE}`);
  }
  return options;
};

type Item = Record<string, AttributeValue>;

export interface Scanner {
  send(command: ScanCommand): Promise<{ Items?: Item[]; LastEvaluatedKey?: Item }>;
}

/** Every item of a table (paginated Scan with a projection). */
export const scanAll = async (
  db: Scanner,
  input: { TableName: string; ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> },
): Promise<Item[]> => {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const page = await db.send(new ScanCommand({ ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
};

const BUCKETS = ["0", "1", "2", "3", "4+"] as const;
const bucket = (count: number): (typeof BUCKETS)[number] => (count >= 4 ? "4+" : (String(Math.max(0, count)) as "0"));
const emptyHistogram = (): Record<string, number> => Object.fromEntries(BUCKETS.map((name) => [name, 0]));
const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export const VALID_SHARE_THRESHOLD = 0.95;

export interface AppAttestReport {
  generatedAt: string;
  keys: {
    total: number;
    byEnvironment: Record<string, number>;
    byStatus: Record<string, number>;
    accountsPerKey: Record<string, number>;
    signupsPerKey: Record<string, number>;
  };
  bindings: { total: number; accounts: number };
  challengesStored: number;
  votes: { days: number; total: number; byOutcome: Record<string, number>; validShare: number | null };
  activeAccounts: { days: number; total: number; withoutBinding: number };
  checks: { votesValidAtLeast95Percent: boolean; everyActiveAccountBound: boolean };
}

export const buildReport = async (input: {
  db: Scanner;
  config: ReportConfig;
  options: Pick<CliOptions, "voteDays" | "activeDays">;
  now?: Date;
}): Promise<AppAttestReport> => {
  const now = input.now ?? new Date();
  const appAttestItems = await scanAll(input.db, {
    TableName: input.config.appAttestTableName,
    ProjectionExpression: "#pk, #sk, #environment, #status, #accountCount, #signupCount",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
      "#environment": "environment",
      "#status": "status",
      "#accountCount": "accountCount",
      "#signupCount": "signupCount",
    },
  });

  const keys: AppAttestReport["keys"] = {
    total: 0,
    byEnvironment: {},
    byStatus: {},
    accountsPerKey: emptyHistogram(),
    signupsPerKey: emptyHistogram(),
  };
  const boundAccounts = new Set<string>();
  let bindingCount = 0;
  let challengesStored = 0;
  for (const item of appAttestItems) {
    const pk = item.pk?.S ?? "";
    if (pk.startsWith("KEY#") && item.sk?.S === "META") {
      keys.total += 1;
      increment(keys.byEnvironment, item.environment?.S ?? "unknown");
      increment(keys.byStatus, item.status?.S ?? "unknown");
      increment(keys.accountsPerKey, bucket(Number(item.accountCount?.N ?? 0)));
      increment(keys.signupsPerKey, bucket(Number(item.signupCount?.N ?? 0)));
    } else if (pk.startsWith("USER#")) {
      bindingCount += 1;
      boundAccounts.add(pk.slice("USER#".length));
    } else if (pk.startsWith("CH#")) {
      challengesStored += 1;
    }
  }

  const userKey = input.config.feedbackPartitionKey;
  const feedbackItems = await scanAll(input.db, {
    TableName: input.config.feedbackTableName,
    ProjectionExpression: "#user, #votedAt, #appAttest",
    ExpressionAttributeNames: { "#user": userKey, "#votedAt": "votedAt", "#appAttest": "appAttest" },
  });
  const dayMs = 24 * 60 * 60 * 1000;
  const voteCutoff = new Date(now.getTime() - input.options.voteDays * dayMs).toISOString();
  const activeCutoff = new Date(now.getTime() - input.options.activeDays * dayMs).toISOString();
  const byOutcome: Record<string, number> = {};
  let votes = 0;
  const activeAccounts = new Set<string>();
  for (const item of feedbackItems) {
    const votedAt = item.votedAt?.S ?? "";
    const userId = item[userKey]?.S;
    if (votedAt >= voteCutoff) {
      votes += 1;
      increment(byOutcome, item.appAttest?.S ?? "none");
    }
    if (userId && votedAt >= activeCutoff) activeAccounts.add(userId);
  }
  const withoutBinding = [...activeAccounts].filter((userId) => !boundAccounts.has(userId)).length;
  const validShare = votes > 0 ? (byOutcome.valid ?? 0) / votes : null;

  return {
    generatedAt: now.toISOString(),
    keys,
    bindings: { total: bindingCount, accounts: boundAccounts.size },
    challengesStored,
    votes: { days: input.options.voteDays, total: votes, byOutcome, validShare },
    activeAccounts: { days: input.options.activeDays, total: activeAccounts.size, withoutBinding },
    checks: {
      votesValidAtLeast95Percent: validShare !== null && validShare >= VALID_SHARE_THRESHOLD,
      everyActiveAccountBound: activeAccounts.size > 0 && withoutBinding === 0,
    },
  };
};

const formatCounts = (counts: Record<string, number>): string =>
  Object.keys(counts).length === 0
    ? "(none)"
    : Object.entries(counts)
        .map(([name, count]) => `${name}=${count}`)
        .join(" ");

export const formatReport = (report: AppAttestReport): string => {
  const percent = report.votes.validShare === null ? "n/a" : `${(report.votes.validShare * 100).toFixed(1)}%`;
  const pass = (ok: boolean) => (ok ? "PASS" : "not yet");
  return [
    `App Attest readiness report (${report.generatedAt}; read-only)`,
    `Keys: total=${report.keys.total}; by environment ${formatCounts(report.keys.byEnvironment)}; by status ${formatCounts(report.keys.byStatus)}`,
    `Accounts per key: ${formatCounts(report.keys.accountsPerKey)}`,
    `Sign-ups per key: ${formatCounts(report.keys.signupsPerKey)}`,
    `Bindings: ${report.bindings.total} for ${report.bindings.accounts} accounts; challenges stored: ${report.challengesStored}`,
    `Votes in the last ${report.votes.days} days: ${report.votes.total}; by outcome ${formatCounts(report.votes.byOutcome)}; valid ${percent}`,
    `Accounts active in the last ${report.activeAccounts.days} days: ${report.activeAccounts.total}; without a binding: ${report.activeAccounts.withoutBinding}`,
    `Check (C3 8.4 votes) at least 95% of votes valid: ${pass(report.checks.votesValidAtLeast95Percent)}`,
    `Check (C3 8.4 votes) every active account has a binding: ${pass(report.checks.everyActiveAccountBound)}`,
  ].join("\n");
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const report = await buildReport({ db: new DynamoDBClient({ region: config.region }), config, options });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("App Attest report failed", error);
    process.exitCode = 1;
  });
}
