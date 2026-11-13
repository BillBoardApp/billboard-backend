import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

interface Options {
  readonly outputsFile: string;
  readonly stacks: readonly string[];
  readonly pollSeconds: number;
  readonly timeoutMinutes: number;
  readonly dryRun: boolean;
}

interface ReleaseTarget {
  readonly stackName: string;
  readonly outputKey: string;
  readonly functionName: string;
  readonly aliasName: string;
  readonly targetVersion: string;
  readonly applicationName: string;
  readonly deploymentGroupName: string;
  readonly aliasVersionParameterName: string;
}

interface AliasState {
  readonly FunctionVersion?: string;
  readonly RoutingConfig?: {
    readonly AdditionalVersionWeights?: Record<string, number>;
  };
}

interface ActiveDeployment {
  readonly target: ReleaseTarget;
  readonly deploymentId: string;
  readonly previousVersion: string;
  done: boolean;
  status?: string;
}

interface DeploymentPlan {
  readonly target: ReleaseTarget;
  readonly currentVersion: string;
  readonly needsDeployment: boolean;
}

type DeploymentInfo = {
  readonly deploymentInfo?: {
    readonly status?: string;
    readonly errorInformation?: {
      readonly code?: string;
      readonly message?: string;
    };
    readonly rollbackInfo?: {
      readonly rollbackMessage?: string;
    };
  };
};

type DeploymentGroupInfo = {
  readonly deploymentGroupInfo?: {
    readonly alarmConfiguration?: {
      readonly alarms?: ReadonlyArray<{ readonly name?: string }>;
    };
  };
};

type AlarmState = {
  readonly AlarmName?: string;
  readonly StateValue?: string;
  readonly StateReason?: string;
  readonly StateUpdatedTimestamp?: string;
};

type DescribeAlarmsOutput = {
  readonly MetricAlarms?: readonly AlarmState[];
  readonly CompositeAlarms?: readonly AlarmState[];
};

const terminalStatuses = new Set(['Succeeded', 'Failed', 'Stopped']);
const failedStatuses = new Set(['Failed', 'Stopped']);

const usage = (): string => [
  'Usage: npm run release:deploy-lambdas -- [--outputs cdk-outputs.json] [--stack StackName] [--timeout-minutes 150]',
  '',
  'Reads Lambda release target outputs emitted by CDK, starts CodeDeploy Lambda',
  'deployments for changed prod aliases, waits for terminal status, and syncs',
  'the SSM alias-version pins to the actual live alias versions.',
].join('\n');

const parseOptions = (argv: string[]): Options => {
  let outputsFile = 'cdk-outputs.json';
  const stacks: string[] = [];
  let pollSeconds = 30;
  let timeoutMinutes = 150;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--outputs') {
      outputsFile = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--stack') {
      stacks.push(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--poll-seconds') {
      pollSeconds = parsePositiveInteger(requireValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--timeout-minutes') {
      timeoutMinutes = parsePositiveInteger(requireValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return { outputsFile, stacks, pollSeconds, timeoutMinutes, dryRun };
};

const requireValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loadTargets = (options: Options): ReleaseTarget[] => {
  if (!existsSync(options.outputsFile)) {
    throw new Error(`CDK outputs file does not exist: ${options.outputsFile}`);
  }

  const outputs = JSON.parse(readFileSync(options.outputsFile, 'utf8')) as Record<string, Record<string, string>>;
  const stackFilter = new Set(options.stacks);
  const targets: ReleaseTarget[] = [];

  for (const [stackName, stackOutputs] of Object.entries(outputs)) {
    if (stackFilter.size > 0 && !stackFilter.has(stackName)) {
      continue;
    }

    for (const [outputKey, outputValue] of Object.entries(stackOutputs)) {
      const parsed = tryParseJson(outputValue);
      if (!isReleaseTarget(parsed)) {
        continue;
      }
      targets.push({ stackName, outputKey, ...parsed });
    }
  }

  return targets.sort((a, b) =>
    `${a.stackName}:${a.functionName}`.localeCompare(`${b.stackName}:${b.functionName}`),
  );
};

const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isReleaseTarget = (value: unknown): value is Omit<ReleaseTarget, 'stackName' | 'outputKey'> => {
  if (!isRecord(value)) {
    return false;
  }

  return [
    'functionName',
    'aliasName',
    'targetVersion',
    'applicationName',
    'deploymentGroupName',
    'aliasVersionParameterName',
  ].every((key) => typeof value[key] === 'string');
};

const aws = (args: string[]): string => {
  try {
    return execFileSync('aws', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(formatCommandError('aws', args, error));
  }
};

const formatCommandError = (command: string, args: string[], error: unknown): string => {
  if (isRecord(error)) {
    const stderr = error.stderr;
    const message = typeof error.message === 'string' ? error.message : '';
    const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : message;
    return `${command} ${args.join(' ')} failed\n${detail.trim()}`;
  }
  return `${command} ${args.join(' ')} failed`;
};

const getAliasState = (target: ReleaseTarget): AliasState => {
  const output = aws([
    'lambda',
    'get-alias',
    '--function-name',
    target.functionName,
    '--name',
    target.aliasName,
    '--output',
    'json',
  ]);
  return JSON.parse(output) as AliasState;
};

const assertAliasReady = (target: ReleaseTarget, aliasState: AliasState): string => {
  const currentVersion = aliasState.FunctionVersion;
  if (!currentVersion || !/^\d+$/.test(currentVersion)) {
    throw new Error(`${target.functionName}:${target.aliasName} has invalid current version ${currentVersion ?? '<missing>'}`);
  }

  const weights = aliasState.RoutingConfig?.AdditionalVersionWeights ?? {};
  if (Object.keys(weights).length > 0) {
    throw new Error(`${target.functionName}:${target.aliasName} already has weighted routing configured; finish or roll back the existing deployment first`);
  }

  return currentVersion;
};

const buildRevision = (target: ReleaseTarget, currentVersion: string): string => {
  const resourceName = target.functionName.replace(/[^A-Za-z0-9]/g, '');
  const appSpec = {
    version: 0.0,
    Resources: [
      {
        [resourceName]: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Name: target.functionName,
            Alias: target.aliasName,
            CurrentVersion: currentVersion,
            TargetVersion: target.targetVersion,
          },
        },
      },
    ],
  };

  return JSON.stringify({
    revisionType: 'String',
    string: {
      content: JSON.stringify(appSpec),
    },
  });
};

const createDeployment = (target: ReleaseTarget, currentVersion: string, dryRun: boolean): string => {
  const revision = buildRevision(target, currentVersion);
  const description = [
    'BillBoard Lambda release',
    `${target.stackName}/${target.functionName}`,
    `${target.aliasName}:${currentVersion}->${target.targetVersion}`,
  ].join(' ');

  if (dryRun) {
    console.log(`[dry-run] would create CodeDeploy deployment for ${description}`);
    return `dry-run-${target.functionName}`;
  }

  return aws([
    'deploy',
    'create-deployment',
    '--application-name',
    target.applicationName,
    '--deployment-group-name',
    target.deploymentGroupName,
    '--revision',
    revision,
    '--description',
    description,
    '--query',
    'deploymentId',
    '--output',
    'text',
  ]);
};

const getDeploymentInfo = (deploymentId: string): DeploymentInfo => {
  const output = aws([
    'deploy',
    'get-deployment',
    '--deployment-id',
    deploymentId,
    '--output',
    'json',
  ]);
  return JSON.parse(output) as DeploymentInfo;
};

/**
 * Lines naming the deployment group's rollback alarms that are in ALARM, so a
 * failed or rolled-back release says what tripped it. Never throws: the
 * deployment failure is what gets reported.
 */
const describeTriggeredAlarms = (target: ReleaseTarget): string[] => {
  try {
    const group = JSON.parse(aws([
      'deploy',
      'get-deployment-group',
      '--application-name',
      target.applicationName,
      '--deployment-group-name',
      target.deploymentGroupName,
      '--output',
      'json',
    ])) as DeploymentGroupInfo;

    const alarmNames = (group.deploymentGroupInfo?.alarmConfiguration?.alarms ?? [])
      .map((alarm) => alarm.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    if (alarmNames.length === 0) {
      return [`no alarms configured on deployment group ${target.deploymentGroupName}`];
    }

    const described = JSON.parse(aws([
      'cloudwatch',
      'describe-alarms',
      '--alarm-types',
      'MetricAlarm',
      'CompositeAlarm',
      '--alarm-names',
      ...alarmNames,
      '--output',
      'json',
    ])) as DescribeAlarmsOutput;

    const inAlarm = [...(described.MetricAlarms ?? []), ...(described.CompositeAlarms ?? [])]
      .filter((alarm) => alarm.StateValue === 'ALARM');
    if (inAlarm.length === 0) {
      return [`none of the ${alarmNames.length} rollback alarm(s) are in ALARM now: ${alarmNames.join(', ')}`];
    }

    return inAlarm.map((alarm) =>
      `ALARM ${alarm.AlarmName ?? '<unnamed>'} since ${alarm.StateUpdatedTimestamp ?? '<unknown>'}: ${alarm.StateReason ?? ''}`.trim(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`could not read rollback alarms: ${message}`];
  }
};

const putAliasVersionParameter = (target: ReleaseTarget, value: string, dryRun: boolean): void => {
  if (dryRun) {
    console.log(`[dry-run] would set ${target.aliasVersionParameterName}=${value}`);
    return;
  }

  aws([
    'ssm',
    'put-parameter',
    '--name',
    target.aliasVersionParameterName,
    '--value',
    value,
    '--type',
    'String',
    '--overwrite',
    '--output',
    'text',
  ]);
};

const syncParameterToLiveAlias = (target: ReleaseTarget, dryRun: boolean): string => {
  if (dryRun) {
    putAliasVersionParameter(target, target.targetVersion, dryRun);
    return target.targetVersion;
  }

  const liveVersion = assertAliasReady(target, getAliasState(target));
  putAliasVersionParameter(target, liveVersion, false);
  return liveVersion;
};

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const waitForDeployments = async (
  deployments: ActiveDeployment[],
  options: Options,
): Promise<void> => {
  if (options.dryRun) {
    for (const deployment of deployments) {
      deployment.done = true;
      deployment.status = 'Succeeded';
      syncParameterToLiveAlias(deployment.target, true);
    }
    return;
  }

  const deadline = Date.now() + options.timeoutMinutes * 60 * 1000;
  const failures: string[] = [];

  while (deployments.some((deployment) => !deployment.done)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for CodeDeploy after ${options.timeoutMinutes} minute(s)`);
    }

    for (const deployment of deployments.filter((candidate) => !candidate.done)) {
      const info = getDeploymentInfo(deployment.deploymentId);
      const status = info.deploymentInfo?.status ?? 'Unknown';

      if (!terminalStatuses.has(status)) {
        console.log(`${deployment.deploymentId} ${deployment.target.functionName}: ${status}`);
        continue;
      }

      deployment.done = true;
      deployment.status = status;
      const liveVersion = syncParameterToLiveAlias(deployment.target, false);
      console.log(`${deployment.deploymentId} ${deployment.target.functionName}: ${status}; live ${deployment.target.aliasName}=${liveVersion}`);

      if (failedStatuses.has(status)) {
        const code = info.deploymentInfo?.errorInformation?.code ?? 'Unknown';
        const message = info.deploymentInfo?.errorInformation?.message ?? 'No CodeDeploy error message returned';
        const rollbackMessage = info.deploymentInfo?.rollbackInfo?.rollbackMessage;
        const failure = [
          `${deployment.target.functionName} ${deployment.deploymentId} ${status}: ${code} ${message}`,
          ...(rollbackMessage ? [`rollback: ${rollbackMessage}`] : []),
          ...describeTriggeredAlarms(deployment.target),
        ].join('\n  ');
        // Logged now as well as at the end: other deployments may run for hours.
        console.error(failure);
        failures.push(failure);
      }
    }

    if (deployments.some((deployment) => !deployment.done)) {
      await sleep(options.pollSeconds * 1000);
    }
  }

  if (failures.length > 0) {
    throw new Error(`One or more Lambda CodeDeploy deployments failed:\n${failures.join('\n')}`);
  }
};

const deploy = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const targets = loadTargets(options);

  if (targets.length === 0) {
    console.log('No Lambda release targets found in CDK outputs.');
    return;
  }

  const plans: DeploymentPlan[] = [];
  for (const target of targets) {
    if (!/^\d+$/.test(target.targetVersion)) {
      throw new Error(`${target.stackName}/${target.outputKey} targetVersion is not a published Lambda version: ${target.targetVersion}`);
    }

    const currentVersion = assertAliasReady(target, getAliasState(target));
    plans.push({
      target,
      currentVersion,
      needsDeployment: currentVersion !== target.targetVersion,
    });
  }

  const deployments: ActiveDeployment[] = [];
  for (const plan of plans) {
    if (!plan.needsDeployment) {
      putAliasVersionParameter(plan.target, plan.currentVersion, options.dryRun);
      console.log(`${plan.target.functionName}:${plan.target.aliasName} already at ${plan.currentVersion}; skipped`);
      continue;
    }

    const deploymentId = createDeployment(plan.target, plan.currentVersion, options.dryRun);
    deployments.push({
      target: plan.target,
      deploymentId,
      previousVersion: plan.currentVersion,
      done: false,
    });
    console.log(`${deploymentId} started for ${plan.target.functionName}:${plan.target.aliasName} ${plan.currentVersion}->${plan.target.targetVersion}`);
  }

  if (deployments.length === 0) {
    console.log('All Lambda prod aliases already point at the CDK target versions.');
    return;
  }

  await waitForDeployments(deployments, options);
};

deploy().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
