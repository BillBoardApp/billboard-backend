import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deploy guard (infra review item 5b). Reads the `cdk diff` output deploy.yml already writes
 * (`$RUNNER_TEMP/cdk-diff.txt`) and fails the run before anything is written to production when the
 * diff would:
 *
 * - replace or delete (destroy or orphan) a Cognito user pool or app client, a DynamoDB table, an S3
 *   bucket or a Secrets Manager secret. A replaced pool or client loses every account or the client
 *   id built into the app; a replaced table, bucket or secret loses its data (named ones fail safe
 *   only because CloudFormation refuses the replacement half-way through the deploy);
 * - replace or delete the UserFeedback stream mapping of BillStatsAggregator. A new mapping starts
 *   at LATEST, so votes cast during the swap never reach the stats, and creating it next to the old one
 *   fails ("mapping already exists"), which stops the multi-stack deploy part-way;
 * - change or delete a poller cursor parameter (/billboard/congress/bills-poller-state, and the 120th's
 *   /billboard/congress/bills-poller-state-120) in any way: any CloudFormation update of it writes UNINITIALIZED over
 *   the live cursor;
 * - replace or delete the SES domain identity (REL-54, EmailStack). A new identity gets new DKIM keys and stays
 *   unverified until SES finds their records, and once the user pool sends through it (REL-54 step 2) no sign-up or
 *   reset code goes out meanwhile. A replacement under the same name also fails half-way through the deploy.
 *
 * Replacing an SQS queue or an SQS event source mapping is reported as a warning only: messages left in the old
 * queue are deleted with it, so drain it first.
 *
 * "may be replaced" counts as a replacement. An intentional replacement is let through only by naming
 * the resource exactly, as `<Stack>/<LogicalId>`, in `--allow` or DEPLOY_GUARD_ALLOW (comma or
 * space separated); deploy.yml passes its `allow_replacements` dispatch input there. It never applies
 * to a push, which has no inputs.
 *
 * The guard reads only stack headers ("Stack <name>") and resource lines ("[~] AWS::Type <path>
 * <LogicalId> <impact>"); property, IAM-table and summary lines are ignored. Input without a single
 * stack header is rejected, so a changed or empty diff cannot pass silently. The CLI also reads the
 * cloud assembly the diff was made from (`--templates cdk.out`) and rejects a diff that has no section
 * for one of its stacks: `cdk diff` stops at the first stack it cannot diff, and behind `| tee` without
 * pipefail that leaves a file that looks complete, while `cdk deploy --all` still deploys every stack.
 */

export type DiffMarker = '+' | '~' | '-' | '←';
export type DiffImpact = 'create' | 'update' | 'replace' | 'may be replaced' | 'destroy' | 'orphan' | 'import' | 'unknown';

export interface DiffResourceChange {
  readonly stack: string;
  readonly marker: DiffMarker;
  readonly type: string;
  readonly logicalId: string;
  /** The construct path cdk prints before the logical id, when it has one. */
  readonly path?: string;
  /**
   * The impact on the resource line, raised to a replacement when one of its property lines says
   * "(requires replacement)" or "(may cause replacement)".
   */
  readonly impact: DiffImpact;
  readonly lineNumber: number;
}

export interface ParsedCdkDiff {
  readonly stacks: string[];
  readonly changes: DiffResourceChange[];
}

export interface GuardFinding {
  /** `<Stack>/<LogicalId>`, the form an allow entry names. */
  readonly resource: string;
  readonly change: DiffResourceChange;
  readonly reason: string;
}

export interface GuardResult {
  readonly stacks: string[];
  readonly blocked: GuardFinding[];
  /** Blocked findings let through by an allow entry. */
  readonly allowed: GuardFinding[];
  readonly warnings: GuardFinding[];
  /** Allow entries that matched nothing the guard would block. */
  readonly unusedAllows: string[];
}

/** Stateful types whose replacement or deletion loses data or every user's sign-in. */
export const PROTECTED_RESOURCE_TYPES: readonly string[] = [
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::S3::Bucket',
  'AWS::SecretsManager::Secret',
];

/** REL-54: the SES domain identity in EmailStack, through which step 2's user pool sends its codes. */
export const SES_EMAIL_IDENTITY_TYPE = 'AWS::SES::EmailIdentity';

/** BillStatsAggregator's UserFeedback stream mapping (AnalyticsServiceStack). */
export const FEEDBACK_STREAM_MAPPING_ID_PREFIX = 'BillStatsAggregatorFeedbackStream';
/**
 * The poller cursors (CongressIntegrationServiceStack): /billboard/congress/bills-poller-state and, since REL-46,
 * /billboard/congress/bills-poller-state-120 (BillsApiPollerStateParameter120). A prefix, so it covers both.
 */
export const POLLER_STATE_PARAMETER_ID_PREFIX = 'BillsApiPollerStateParameter';

const REPLACING_IMPACTS: ReadonlySet<DiffImpact> = new Set<DiffImpact>([
  'replace',
  'may be replaced',
  'destroy',
  'orphan',
  // A resource line the guard could not read the impact of is treated as the worst case.
  'unknown',
]);

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const STACK_HEADER = /^Stack (\S+)/;
const RESOURCE_LINE = /^\[([+~\-←])\] ((?:AWS|Custom|Alexa)::\S+) (.+)$/;
const TRAILING_IMPACTS: ReadonlyArray<[string, DiffImpact]> = [
  [' may be replaced', 'may be replaced'],
  [' replace', 'replace'],
  [' destroy', 'destroy'],
  [' orphan', 'orphan'],
  [' import', 'import'],
];
const LOGICAL_ID = /^[A-Za-z0-9]+$/;

const defaultImpact = (marker: DiffMarker): DiffImpact => {
  if (marker === '+') return 'create';
  if (marker === '~') return 'update';
  if (marker === '←') return 'import';
  // A removal always names destroy or orphan; without one, assume the worst.
  return 'unknown';
};

// How strongly an impact replaces the resource; property lines can only raise it.
const IMPACT_RANK: Readonly<Record<DiffImpact, number>> = {
  create: 0,
  update: 0,
  import: 0,
  'may be replaced': 1,
  replace: 2,
  destroy: 2,
  orphan: 2,
  unknown: 3,
};
// A property line of the current resource: " ├─ [~] QueueName (requires replacement)", at any depth.
const PROPERTY_LINE = /^\s+[│├└\s]*[├└]─/;

/**
 * Reads the stack headers and resource lines of `cdk diff` output (colour codes are stripped). A
 * resource's property lines that say "(requires replacement)" or "(may cause replacement)" raise its
 * impact, so a replacement is caught even if the resource line's own wording ever changes.
 */
export const parseCdkDiff = (text: string): ParsedCdkDiff => {
  const stacks: string[] = [];
  const changes: DiffResourceChange[] = [];
  let stack: string | undefined;
  let current: { -readonly [K in keyof DiffResourceChange]: DiffResourceChange[K] } | undefined;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(ANSI_ESCAPE, '').trimEnd();
    const header = STACK_HEADER.exec(line);
    if (header) {
      stack = header[1];
      stacks.push(stack);
      current = undefined;
      return;
    }
    const resource = RESOURCE_LINE.exec(line);
    if (!resource) {
      if (current && PROPERTY_LINE.test(line)) {
        const implied: DiffImpact | undefined = line.includes('(requires replacement)')
          ? 'replace'
          : line.includes('(may cause replacement)')
            ? 'may be replaced'
            : undefined;
        if (implied && IMPACT_RANK[implied] > IMPACT_RANK[current.impact]) current.impact = implied;
      } else if (!/^\s/.test(line)) {
        // Any other line that starts at column 0 ends the resource's property block.
        current = undefined;
      }
      return;
    }
    const [, markerText, type, rest] = resource;
    const marker = markerText as DiffMarker;

    let remainder = rest.trim();
    let impact: DiffImpact | undefined;
    for (const [suffix, value] of TRAILING_IMPACTS) {
      if (remainder.endsWith(suffix)) {
        impact = value;
        remainder = remainder.slice(0, -suffix.length).trim();
        break;
      }
    }
    const tokens = remainder.split(/\s+/);
    const logicalId = tokens[tokens.length - 1];
    const path = tokens.length > 1 ? tokens.slice(0, -1).join(' ') : undefined;
    current = {
      stack: stack ?? '<no stack header>',
      marker,
      type,
      logicalId,
      ...(path ? { path } : {}),
      // A last word that is not a logical id is an impact this version of the guard does not know.
      impact: impact ?? (LOGICAL_ID.test(logicalId) ? defaultImpact(marker) : 'unknown'),
      lineNumber: index + 1,
    };
    changes.push(current);
  });

  return { stacks, changes };
};

const startsWithId = (change: DiffResourceChange, prefix: string): boolean =>
  change.logicalId.startsWith(prefix) || (change.path?.startsWith(prefix) ?? false);

/** Why `change` must not deploy, or null when it may. */
export const blockReason = (change: DiffResourceChange): string | null => {
  if (PROTECTED_RESOURCE_TYPES.includes(change.type) && REPLACING_IMPACTS.has(change.impact)) {
    return `${change.type} would be ${describeImpact(change.impact)}: its data (or every user's sign-in) would be lost`;
  }
  if (change.type === SES_EMAIL_IDENTITY_TYPE && REPLACING_IMPACTS.has(change.impact)) {
    return `the SES email identity would be ${describeImpact(change.impact)}: a new one has new DKIM keys and is unverified until SES finds their records; once the user pool sends through it (REL-54 step 2), no sign-up or reset code goes out meanwhile`;
  }
  if (
    change.type === 'AWS::Lambda::EventSourceMapping' &&
    startsWithId(change, FEEDBACK_STREAM_MAPPING_ID_PREFIX) &&
    REPLACING_IMPACTS.has(change.impact)
  ) {
    return `the UserFeedback stream mapping would be ${describeImpact(change.impact)}: a new mapping starts at LATEST (votes in the gap never reach the stats) and fails while the old one exists`;
  }
  if (
    change.type === 'AWS::SSM::Parameter' &&
    startsWithId(change, POLLER_STATE_PARAMETER_ID_PREFIX) &&
    (change.marker === '~' || change.marker === '-')
  ) {
    return 'the poller cursor parameter would be updated or removed: any CloudFormation update writes UNINITIALIZED over the live cursor';
  }
  return null;
};

/** Why `change` deserves a look, for changes that may still deploy. */
export const warningReason = (change: DiffResourceChange): string | null => {
  if (
    (change.type === 'AWS::SQS::Queue' || change.type === 'AWS::Lambda::EventSourceMapping') &&
    REPLACING_IMPACTS.has(change.impact)
  ) {
    return `${change.type} would be ${describeImpact(change.impact)}: messages left in the old queue are deleted with it (drain it first)`;
  }
  return null;
};

const describeImpact = (impact: DiffImpact): string => {
  if (impact === 'unknown') return 'changed in a way the guard cannot read (treated as a replacement)';
  if (impact === 'may be replaced') return 'possibly replaced';
  if (impact === 'replace') return 'replaced';
  if (impact === 'destroy') return 'deleted';
  if (impact === 'orphan') return 'removed from the stack (orphaned)';
  return impact;
};

export const resourceKey = (change: DiffResourceChange): string => `${change.stack}/${change.logicalId}`;

/** Splits allow entries given as repeated flags or one comma- or space-separated string. */
export const parseAllowList = (values: ReadonlyArray<string | undefined>): string[] => {
  const entries = values
    .flatMap((value) => (value ?? '').split(/[\s,]+/))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  entries.forEach((entry) => {
    if (!/^[A-Za-z][A-Za-z0-9-]*\/[A-Za-z0-9]+$/.test(entry)) {
      throw new Error(`Allow entry '${entry}' must be <Stack>/<LogicalId>, for example UserAPIServiceStack/BillboardUserPoolC41FE3DD`);
    }
  });
  return [...new Set(entries)];
};

/**
 * The names `cdk diff` prints in each "Stack <name>" header for a cloud assembly's manifest.json: every
 * stack artifact's display name, else its id (the header's first word; a stack whose stackName differs
 * from its id adds " (<stackName>)"). A nested assembly (a Stage) is refused rather than half-checked.
 */
export const synthesizedStackNames = (manifestJson: string): string[] => {
  const manifest = JSON.parse(manifestJson) as {
    artifacts?: Record<string, { type?: string; displayName?: string }>;
  };
  const names: string[] = [];
  for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
    if (artifact.type === 'cdk:cloud-assembly') {
      throw new Error(`The cloud assembly nests another one (${id}); the guard checks only top-level stacks`);
    }
    if (artifact.type === 'aws:cloudformation:stack') names.push(artifact.displayName ?? id);
  }
  if (names.length === 0) throw new Error('The cloud assembly has no stacks, so the diff cannot be checked against it');
  return names;
};

export const evaluateDeployGuard = (
  text: string,
  allow: readonly string[] = [],
  /** The synthesized stacks (synthesizedStackNames): each must have its section in the diff. */
  expectedStacks?: readonly string[],
): GuardResult => {
  const { stacks, changes } = parseCdkDiff(text);
  if (stacks.length === 0) {
    throw new Error('No "Stack <name>" line found: this is not cdk diff output, so nothing can be checked');
  }
  const missing = (expectedStacks ?? []).filter((name) => !stacks.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `The diff has no "Stack <name>" section for ${missing.length} of the ${expectedStacks!.length} synthesized stacks ` +
        `(${missing.join(', ')}): cdk diff stopped part-way or the file is cut short, so those stacks were never checked`,
    );
  }

  const allowSet = new Set(allow);
  const usedAllows = new Set<string>();
  const blocked: GuardFinding[] = [];
  const allowed: GuardFinding[] = [];
  const warnings: GuardFinding[] = [];

  for (const change of changes) {
    const resource = resourceKey(change);
    const block = blockReason(change);
    if (block) {
      if (allowSet.has(resource)) {
        usedAllows.add(resource);
        allowed.push({ resource, change, reason: block });
      } else {
        blocked.push({ resource, change, reason: block });
      }
      continue;
    }
    const warning = warningReason(change);
    if (warning) warnings.push({ resource, change, reason: warning });
  }

  return {
    stacks,
    blocked,
    allowed,
    warnings,
    unusedAllows: [...allowSet].filter((entry) => !usedAllows.has(entry)),
  };
};

const usage = (): string =>
  [
    'Usage: npm run release:check-deploy-guard -- --diff <cdk-diff.txt> --templates <cdk.out> [--allow <Stack>/<LogicalId>]...',
    '',
    'Fails (exit 1) when the cdk diff output would replace or delete a Cognito user pool or client, a',
    'DynamoDB table, an S3 bucket, a Secrets Manager secret or the UserFeedback stream mapping, or would',
    'change the poller cursor parameter. SQS queue and SQS mapping replacements are warnings. An allow',
    'entry (also read from DEPLOY_GUARD_ALLOW, comma or space separated) lets one named resource through.',
    '--templates names the cloud assembly the diff was made from; every stack in it needs its section in the diff.',
    'Exit 2: the input is missing or is not cdk diff output, or a synthesized stack has no section in it.',
  ].join('\n');

interface CliOptions {
  readonly diffPath?: string;
  readonly templatesDir?: string;
  readonly allow: string[];
  readonly help: boolean;
}

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  let diffPath: string | undefined;
  let templatesDir: string | undefined;
  const allowFlags: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--diff' || arg === '--templates' || arg === '--allow') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value\n\n${usage()}`);
      if (arg === '--diff') diffPath = value;
      else if (arg === '--templates') templatesDir = value;
      else allowFlags.push(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return { diffPath, templatesDir, allow: allowFlags, help };
};

export interface RunGuardOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => string;
  readonly log?: (line: string) => void;
  readonly appendSummary?: (markdown: string) => void;
}

/** The CLI, with its I/O injected: returns the exit code. */
export const runDeployGuard = ({
  argv,
  env = process.env,
  readFile = (path) => readFileSync(path, 'utf8'),
  log = (line) => console.log(line),
  appendSummary,
}: RunGuardOptions): number => {
  const inActions = env.GITHUB_ACTIONS === 'true';
  const annotate = (level: 'error' | 'warning' | 'notice', message: string): void =>
    log(inActions ? `::${level} title=Deploy guard::${message}` : `${level.toUpperCase()}: ${message}`);

  let options: CliOptions;
  let allow: string[];
  let text: string;
  let expectedStacks: string[];
  try {
    options = parseCliArgs(argv);
    if (options.help) {
      log(usage());
      return 0;
    }
    if (!options.diffPath) throw new Error(`--diff is required\n\n${usage()}`);
    if (!options.templatesDir) throw new Error(`--templates is required\n\n${usage()}`);
    allow = parseAllowList([...options.allow, env.DEPLOY_GUARD_ALLOW]);
    text = readFile(options.diffPath);
    expectedStacks = synthesizedStackNames(readFile(join(options.templatesDir, 'manifest.json')));
  } catch (error) {
    annotate('error', error instanceof Error ? error.message : String(error));
    return 2;
  }

  let result: GuardResult;
  try {
    result = evaluateDeployGuard(text, allow, expectedStacks);
  } catch (error) {
    annotate('error', error instanceof Error ? error.message : String(error));
    return 2;
  }

  const describe = (finding: GuardFinding): string =>
    `${finding.resource} (${finding.change.type}, diff line ${finding.change.lineNumber}): ${finding.reason}`;

  log(`Deploy guard: ${result.stacks.length} stacks checked.`);
  result.warnings.forEach((finding) => annotate('warning', describe(finding)));
  result.allowed.forEach((finding) => annotate('warning', `Allowed by allow_replacements: ${describe(finding)}`));
  result.unusedAllows.forEach((entry) =>
    annotate('notice', `Allow entry ${entry} matched nothing the guard blocks; it was not needed.`),
  );
  result.blocked.forEach((finding) => annotate('error', describe(finding)));

  const summaryLines = [
    '### Deploy guard',
    '',
    result.blocked.length > 0
      ? `**Blocked**: ${result.blocked.length} change(s) would replace or delete stateful resources. Nothing was deployed.`
      : `Passed: no stateful resource is replaced or deleted (${result.stacks.length} stacks).`,
    ...result.blocked.map((finding) => `- blocked: \`${finding.resource}\` ${finding.reason}`),
    ...result.allowed.map((finding) => `- allowed by input: \`${finding.resource}\` ${finding.reason}`),
    ...result.warnings.map((finding) => `- warning: \`${finding.resource}\` ${finding.reason}`),
    '',
  ];
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const writeSummary = appendSummary ?? (summaryFile ? (markdown: string) => appendFileSync(summaryFile, markdown) : undefined);
  writeSummary?.(`${summaryLines.join('\n')}\n`);

  if (result.blocked.length > 0) {
    log(
      'If a replacement is intended, run deploy.yml by hand with allow_replacements naming each resource above ' +
        '(<Stack>/<LogicalId>), after making sure its data is backed up or moved.',
    );
    return 1;
  }
  log('Deploy guard passed.');
  return 0;
};

if (require.main === module) {
  process.exitCode = runDeployGuard({ argv: process.argv.slice(2) });
}
