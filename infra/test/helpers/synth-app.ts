import * as fs from 'node:fs';
import * as path from 'node:path';

export type Json = Record<string, any>;

export interface SynthesizedAppStack {
  readonly name: string;
  readonly template: Json;
  readonly account: string;
  readonly region: string;
  /** Names of the stacks this stack depends on (asset manifests are left out). */
  readonly dependencies: string[];
}

const infraRoot = path.join(__dirname, '..', '..');
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(path.join(infraRoot, file), 'utf8'));
/** The CLI's cached lookups, when there are any. */
export const cachedLookups = (): Json =>
  fs.existsSync(path.join(infraRoot, 'cdk.context.json')) ? readJson('cdk.context.json') : {};

/**
 * Builds bin/billboard-infra.ts the way `cdk synth` runs it: the CLI hands the app the cdk.json
 * context and any cached lookups in cdk.context.json (none today: the app looks nothing up) through
 * CDK_CONTEXT_JSON. Jest gives each test file its own module registry, so each file that calls this
 * synthesizes the app once.
 */
const synthesizeAssembly = () => {
  const previousContext = process.env.CDK_CONTEXT_JSON;
  process.env.CDK_CONTEXT_JSON = JSON.stringify({
    ...readJson('cdk.json').context,
    ...cachedLookups(),
  });
  try {
    const { app } = require('../../bin/billboard-infra') as typeof import('../../bin/billboard-infra');
    return app.synth();
  } finally {
    if (previousContext === undefined) {
      delete process.env.CDK_CONTEXT_JSON;
    } else {
      process.env.CDK_CONTEXT_JSON = previousContext;
    }
  }
};

export const synthesizeApp = (): SynthesizedAppStack[] => {
  const stacks = synthesizeAssembly().stacks;
  const stackIds = new Set(stacks.map((stack) => stack.id));
  return stacks.map((stack) => ({
    name: stack.stackName,
    template: stack.template as Json,
    account: stack.environment.account,
    region: stack.environment.region,
    dependencies: stack.dependencies.map((dependency) => dependency.id).filter((id) => stackIds.has(id)).sort(),
  }));
};

/** The manifest.json of the same synth: what `cdk diff --app cdk.out --all` reads to pick its stacks. */
export const synthesizedAppManifest = (): string =>
  fs.readFileSync(path.join(synthesizeAssembly().directory, 'manifest.json'), 'utf8');

/** The directory of the same synth, laid out like `cdk.out`: templates, asset manifests and manifest.json. */
export const synthesizedAppDirectory = (): string => synthesizeAssembly().directory;
