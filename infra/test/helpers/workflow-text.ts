import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toIamAction } from './github-oidc-roles';

/**
 * Reading a GitHub Actions workflow the way the deploy workflow's tests need it, as text: its jobs (two spaces in),
 * their steps (six spaces in), a step's `if:` and `with:` inputs, and the AWS CLI calls in a piece of it.
 */

export const REPOSITORY_ROOT = join(__dirname, '..', '..', '..');

/** A workflow file of this repository, by its name under .github/workflows. */
export const readWorkflow = (name: string): string =>
  readFileSync(join(REPOSITORY_ROOT, '.github', 'workflows', name), 'utf8');

/** One job of a workflow, from its header (two spaces in) to the next job's header. */
export const jobText = (workflow: string, name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect({ job: name, found: start >= 0 }).toEqual({ job: name, found: true });
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

/** The steps of a job (six spaces in), each as its own text. */
export const stepsOf = (job: string): string[] => job.split(/\n(?= {6}- )/).slice(1);

export const stepIf = (step: string): string | undefined => step.match(/^ {8}if: (.+)$/m)?.[1].trim();

/** A `with:` input of a step (ten spaces in); a `>-` folded block is joined the way YAML folds it. */
export const stepInput = (step: string, input: string): string | undefined => {
  const lines = step.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`          ${input}:`));
  if (index < 0) {
    return undefined;
  }
  const value = lines[index].slice(`          ${input}:`.length).trim();
  if (value !== '>-') {
    return value;
  }
  const folded: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.startsWith('            ')) {
      break;
    }
    folded.push(line.trim());
  }
  return folded.join(' ');
};

/** The script of a step's `run: |` block (ten spaces in), as the runner's shell gets it. */
export const stepRun = (step: string): string => {
  const lines = step.split('\n');
  const start = lines.indexOf('        run: |');
  expect({ step: lines[0], run: start >= 0 }).toEqual({ step: lines[0], run: true });
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('          ')) {
      break;
    }
    body.push(line.slice(10));
  }
  return `${body.join('\n').trimEnd()}\n`;
};

/** The steps of a job that take AWS credentials. */
export const credentialSteps = (job: string): string[] =>
  stepsOf(job).filter((step) => /^ {6}- (?:[^\n]*\n {8})*uses: aws-actions\/configure-aws-credentials@/.test(step));

/** `aws <service> <operation>` lines in a piece of a workflow, as IAM actions. S3 copies must be downloads. */
export const awsCallsIn = (text: string): string[] => {
  const calls = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s;&|(])aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)([^\n]*)/gm)) {
    const [, service, operation, rest] = match;
    if (service === 's3' && operation === 'cp') {
      // Only downloads (s3:// source first) are expected from the deploy job.
      expect(rest.trim().startsWith('"s3://') || rest.trim().startsWith('s3://')).toBe(true);
      calls.add('s3:GetObject');
    } else if (service === 's3' && operation === 'ls') {
      calls.add('s3:ListBucket');
    } else {
      calls.add(toIamAction(service, operation));
    }
  }
  return [...calls].sort();
};
