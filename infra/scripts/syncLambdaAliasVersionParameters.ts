import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Options {
  readonly templatesDir: string;
  readonly aliasName: string;
  readonly dryRun: boolean;
  readonly listTargets: boolean;
}

interface AliasVersionTarget {
  readonly templateFile: string;
  readonly functionName: string;
  readonly aliasName: string;
  readonly parameterName: string;
}

type CfnResource = {
  readonly Type?: string;
  readonly Properties?: Record<string, unknown>;
};

type CfnTemplate = {
  readonly Resources?: Record<string, CfnResource>;
};

const usage = (): string => [
  'Usage: npm run release:sync-prod-alias-versions -- [--templates cdk.out] [--alias prod] [--dry-run] [--list-targets]',
  '',
  'Reads synthesized CloudFormation templates, finds Lambda aliases pinned with',
  'SSM dynamic references, and writes each SSM parameter to the currently live',
  'Lambda alias version. Run this immediately before cdk deploy.',
].join('\n');

const parseOptions = (argv: string[]): Options => {
  let templatesDir = 'cdk.out';
  let aliasName = 'prod';
  let dryRun = false;
  let listTargets = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--templates') {
      templatesDir = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--alias') {
      aliasName = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--list-targets') {
      listTargets = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return { templatesDir, aliasName, dryRun, listTargets };
};

const requireValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const listTemplateFiles = (dir: string): string[] => {
  if (!existsSync(dir)) {
    throw new Error(`Template directory does not exist: ${dir}`);
  }

  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listTemplateFiles(fullPath));
    } else if (entry.endsWith('.template.json')) {
      files.push(fullPath);
    }
  }
  return files.sort();
};

const loadTemplate = (filePath: string): CfnTemplate => {
  const contents = readFileSync(filePath, 'utf8');
  return JSON.parse(contents) as CfnTemplate;
};

const resolveFunctionName = (
  functionNameProperty: unknown,
  resources: Record<string, CfnResource>,
): string => {
  if (typeof functionNameProperty === 'string') {
    return functionNameProperty;
  }

  if (
    isRecord(functionNameProperty)
    && typeof functionNameProperty.Ref === 'string'
    && resources[functionNameProperty.Ref]?.Type === 'AWS::Lambda::Function'
  ) {
    const functionName = resources[functionNameProperty.Ref].Properties?.FunctionName;
    if (typeof functionName === 'string') {
      return functionName;
    }
  }

  throw new Error(`Unable to resolve Lambda FunctionName from ${JSON.stringify(functionNameProperty)}`);
};

const resolveTemplateString = (
  value: unknown,
  resources: Record<string, CfnResource>,
): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (isRecord(value) && Array.isArray(value['Fn::Join'])) {
    const [separator, parts] = value['Fn::Join'];
    if (typeof separator !== 'string' || !Array.isArray(parts)) {
      return undefined;
    }

    const resolvedParts = parts.map((part) => resolveTemplateString(part, resources));
    if (resolvedParts.some((part) => part === undefined)) {
      return undefined;
    }

    return resolvedParts.join(separator);
  }

  if (
    isRecord(value)
    && typeof value.Ref === 'string'
    && resources[value.Ref]?.Type === 'AWS::Lambda::Function'
  ) {
    const functionName = resources[value.Ref].Properties?.FunctionName;
    return typeof functionName === 'string' ? functionName : undefined;
  }

  return undefined;
};

const extractSsmParameterName = (
  functionVersionProperty: unknown,
  resources: Record<string, CfnResource>,
): string | undefined => {
  const rendered = resolveTemplateString(functionVersionProperty, resources);
  if (!rendered) {
    return undefined;
  }

  const match = rendered.match(/^\{\{resolve:ssm:([^}:]+)(?::\d+)?\}\}$/);
  return match?.[1];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const discoverTargets = (templatesDir: string, aliasName: string): AliasVersionTarget[] => {
  const targets = new Map<string, AliasVersionTarget>();

  for (const templateFile of listTemplateFiles(templatesDir)) {
    const template = loadTemplate(templateFile);
    const resources = template.Resources ?? {};

    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::Lambda::Alias') {
        continue;
      }
      if (resource.Properties?.Name !== aliasName) {
        continue;
      }

      const parameterName = extractSsmParameterName(resource.Properties.FunctionVersion, resources);
      if (!parameterName) {
        continue;
      }

      const functionName = resolveFunctionName(resource.Properties.FunctionName, resources);
      targets.set(`${functionName}:${aliasName}`, {
        templateFile,
        functionName,
        aliasName,
        parameterName,
      });
    }
  }

  return [...targets.values()].sort((a, b) => a.functionName.localeCompare(b.functionName));
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

// Version CloudFormation publishes first for a function it is about to create.
const BOOTSTRAP_ALIAS_VERSION = '1';

const isAwsErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && error.message.includes(`(${code})`);

/** Returns undefined when the function or alias does not exist yet. */
const getAliasVersion = (functionName: string, aliasName: string): string | undefined => {
  try {
    return aws([
      'lambda',
      'get-alias',
      '--function-name',
      functionName,
      '--name',
      aliasName,
      '--query',
      'FunctionVersion',
      '--output',
      'text',
    ]);
  } catch (error) {
    if (isAwsErrorCode(error, 'ResourceNotFoundException')) {
      return undefined;
    }
    throw error;
  }
};

const putParameter = (name: string, value: string, dryRun: boolean): void => {
  if (dryRun) {
    console.log(`[dry-run] aws ssm put-parameter --name ${name} --value ${value} --type String --overwrite`);
    return;
  }

  aws([
    'ssm',
    'put-parameter',
    '--name',
    name,
    '--value',
    value,
    '--type',
    'String',
    '--overwrite',
    '--output',
    'text',
  ]);
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const targets = discoverTargets(options.templatesDir, options.aliasName);

  if (targets.length === 0) {
    throw new Error(`No ${options.aliasName} Lambda aliases with SSM-pinned versions were found in ${options.templatesDir}`);
  }

  if (options.listTargets) {
    console.log(JSON.stringify(targets, null, 2));
    return;
  }

  console.log(`Syncing ${targets.length} Lambda alias version parameter(s) from live ${options.aliasName} aliases...`);
  for (const target of targets) {
    const liveVersion = getAliasVersion(target.functionName, target.aliasName);
    if (liveVersion === undefined) {
      // A brand-new function: the pin must exist before cdk deploy resolves it.
      putParameter(target.parameterName, BOOTSTRAP_ALIAS_VERSION, options.dryRun);
      console.log(
        `${target.functionName}:${target.aliasName} not found; bootstrapped ${target.parameterName} to ${BOOTSTRAP_ALIAS_VERSION}`,
      );
      continue;
    }
    if (!/^\d+$/.test(liveVersion)) {
      throw new Error(`${target.functionName}:${target.aliasName} resolved to non-version value ${liveVersion}`);
    }

    putParameter(target.parameterName, liveVersion, options.dryRun);
    console.log(`${target.functionName}:${target.aliasName} -> ${liveVersion} (${target.parameterName})`);
  }
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
