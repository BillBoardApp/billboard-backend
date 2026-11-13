import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LAMBDA_ARTIFACTS_BUCKET_NAME, GITHUB_INFRA_DEPLOY_ROLE_NAME, GITHUB_SERVICES_RELEASE_ROLE_NAME } from '../lib/stacks/github-oidc';
import {
  ACCOUNT,
  BUCKET_ARN,
  INFRA_ROOT,
  REGION,
  actionsOf,
  appDirectory,
  asArray,
  bootstrapRolesOfApp,
  roleAllows,
  roleNamed,
  synthOidcStack,
  type SessionPolicy,
} from './helpers/github-oidc-roles';
import { awsCallsIn, credentialSteps, jobText, readWorkflow, stepIf, stepInput, stepsOf } from './helpers/workflow-text';

/**
 * The production deploy workflow, .github/workflows/deploy.yml (docs/DEPLOYING.md): one job, `deploy`, holds all AWS
 * work in the `production` environment. It publishes the release with the services release role, clears those
 * credentials, installs, and only then takes the infra deploy role, narrowed for a diff run. The deploy guard runs
 * before any production write, and the CodeDeploy wait fits the job's timeout. workflows.test.ts checks the rules
 * every workflow follows.
 */
const ACCOUNT_SECRET = '${{ secrets.AWS_ACCOUNT_ID }}';
const raw = readWorkflow('deploy.yml');
/** The workflow as a run sees it, with the deployment's account in place of the secret. */
const workflow = raw.split(ACCOUNT_SECRET).join(ACCOUNT);
const deployJob = jobText(workflow, 'deploy');

const RELEASE_BUILT_HERE = "env.EXISTING_RELEASE_ID == ''";
const DIFF_ONLY = "env.MODE == 'diff'";
const DEPLOY_ONLY = "env.MODE == 'deploy'";

/** The index in the deploy job of the step with this name, or of this exact line. */
const indexIn = (job: string, marker: string): number => {
  const index = job.indexOf(marker);
  expect({ marker, found: index >= 0 }).toEqual({ marker, found: true });
  return index;
};

/** The step of the deploy job with this name. */
const stepNamed = (name: string): string => {
  const step = stepsOf(deployJob).find((candidate) => candidate.includes(`name: ${name}\n`));
  expect({ name, found: step !== undefined }).toEqual({ name, found: true });
  return step!;
};

/** Steps that can run in a diff run with the infra deploy role: after its credentials, and not gated to deploy mode. */
const diffModeSteps = (): string[] => {
  const steps = stepsOf(deployJob);
  const first = steps.findIndex((step) => step.includes('name: AWS credentials for a diff'));
  expect(first).toBeGreaterThan(0);
  return steps.slice(first).filter((step) => stepIf(step) !== DEPLOY_ONLY);
};

const diffSessionPolicy = (): SessionPolicy => {
  const [diffStep] = credentialSteps(deployJob).filter((step) => stepIf(step) === DIFF_ONLY);
  return JSON.parse(stepInput(diffStep, 'inline-session-policy') ?? 'null') as SessionPolicy;
};

describe('deploy.yml: only an approved run on main reaches AWS', () => {
  test('a push only verifies and builds; a manual run on main chooses diff or deploy', () => {
    const plan = jobText(raw, 'plan');
    expect(plan).toContain('if [ "$GITHUB_REF" = "refs/heads/main" ] && [ "$EVENT_NAME" = "workflow_dispatch" ]; then mode="$INPUT_MODE"');
    expect(plan).toContain('else mode=off; fi');
    expect(raw).not.toContain('vars.DEPLOY_MODE');
    expect(deployJob).toMatch(/^ {4}if: needs\.plan\.outputs\.mode != 'off' && needs\.build\.result == 'success'$/m);
  });

  test('the deploy job runs in the production environment and holds the production lock, not the workflow', () => {
    expect(deployJob).toMatch(/^ {4}environment: production$/m);
    expect(deployJob).toMatch(/^ {4}concurrency:\n {6}group: billboard-production\n {6}cancel-in-progress: false$/m);
    // No workflow-level lock: a push run, which never reaches AWS, never waits behind a deploy waiting for approval.
    expect(raw.slice(0, raw.indexOf('\njobs:\n'))).not.toMatch(/^concurrency:/m);
    expect(raw.match(/concurrency:/g)).toHaveLength(1);
  });

  test('the account ID comes only from the environment secret, and the diff summary leaves it out', () => {
    expect(raw).not.toMatch(/\b\d{12}\b/);
    expect(raw.match(/arn:aws:iam::[^:\n]*:role\//g)?.every((arn) => arn === `arn:aws:iam::${ACCOUNT_SECRET}:role/`)).toBe(true);
    expect(jobText(raw, 'deploy')).toMatch(/^ {6}CDK_DEFAULT_ACCOUNT: \$\{\{ secrets\.AWS_ACCOUNT_ID \}\}$/m);
    expect(raw).toContain(`          ACCOUNT_ID: ${ACCOUNT_SECRET}\n`);
    const diff = stepNamed('Diff against production');
    expect(diff).toContain('sed "s/${ACCOUNT_ID:?}/***/g"; echo \'```\'; } >> "$GITHUB_STEP_SUMMARY"');
    for (const step of credentialSteps(deployJob)) {
      expect(stepInput(step, 'mask-aws-account-id')).toBe('true');
    }
  });

  test('no deploy record: the only artifact is the 7-day lambda-release', () => {
    expect(raw).not.toContain('deploy-record');
    expect(raw).not.toContain('cdk-outputs.json\n          if-no-files-found');
    expect(raw.match(/uses: actions\/upload-artifact@/g)).toHaveLength(1);
    const upload = stepsOf(jobText(raw, 'build')).find((step) => step.includes('uses: actions/upload-artifact@'))!;
    expect(stepInput(upload, 'name')).toBe('lambda-release');
    expect(stepInput(upload, 'retention-days')).toBe('7');
  });
});

describe('deploy.yml uses the GitHubOidcStack roles', () => {
  const template = synthOidcStack();
  const servicesRole = roleNamed(template, GITHUB_SERVICES_RELEASE_ROLE_NAME);
  const infraRole = roleNamed(template, GITHUB_INFRA_DEPLOY_ROLE_NAME);
  const roleArn = (roleName: string): string => `arn:aws:iam::${ACCOUNT}:role/${roleName}`;
  const deploySteps = credentialSteps(deployJob);

  test('only the deploy job takes credentials: the release role for the upload, then the infra deploy role per mode', () => {
    expect(workflow).not.toContain('role/GitHubAutomation');
    expect(workflow.match(/uses: aws-actions\/configure-aws-credentials@/g)).toHaveLength(3);
    expect(credentialSteps(jobText(workflow, 'plan'))).toEqual([]);
    expect(credentialSteps(jobText(workflow, 'build'))).toEqual([]);
    expect(deploySteps.map((step) => [stepIf(step), stepInput(step, 'role-to-assume')])).toEqual([
      [RELEASE_BUILT_HERE, roleArn(GITHUB_SERVICES_RELEASE_ROLE_NAME)],
      [DIFF_ONLY, roleArn(GITHUB_INFRA_DEPLOY_ROLE_NAME)],
      [DEPLOY_ONLY, roleArn(GITHUB_INFRA_DEPLOY_ROLE_NAME)],
    ]);
  });

  test('the infra deploy role covers every AWS call made by the deploy workflow', () => {
    const granted = actionsOf(infraRole);
    expect(awsCallsIn(workflow).filter((action) => !granted.has(action))).toEqual([]);
  });

  test("each session fits its role's maximum session duration", () => {
    const [releaseStep, ...infraSteps] = deploySteps;
    for (const [steps, role] of [[[releaseStep], servicesRole], [infraSteps, infraRole]] as const) {
      for (const step of steps) {
        const seconds = Number(stepInput(step, 'role-duration-seconds'));
        expect(seconds).toBeGreaterThan(0);
        expect(seconds).toBeLessThanOrEqual(role.Properties.MaxSessionDuration ?? 3600);
      }
    }
  });

  test('the release is published before any package is installed, and its credentials are cleared first', () => {
    const publish = indexIn(deployJob, 'name: Publish zips, then the manifest\n');
    const clear = indexIn(deployJob, 'name: Clear the upload credentials\n');
    const noCredentials = indexIn(deployJob, 'name: No AWS credentials while packages install\n');
    const setupNode = indexIn(deployJob, 'uses: actions/setup-node@');
    const npmCi = indexIn(deployJob, '- run: npm ci\n');
    const [releaseCredentials, diffCredentials, deployCredentials] = deploySteps.map((step) => deployJob.indexOf(step));
    expect(releaseCredentials).toBeLessThan(publish);
    expect(publish).toBeLessThan(clear);
    expect(clear).toBeLessThan(setupNode);
    expect(setupNode).toBeLessThan(noCredentials);
    expect(noCredentials).toBeLessThan(npmCi);
    expect(npmCi).toBeLessThan(diffCredentials);
    expect(npmCi).toBeLessThan(deployCredentials);
    // Every upload step runs only when this run built the release; a rollback publishes nothing.
    for (const name of ['Download the release this run built', 'The release belongs to this commit',
      'AWS credentials for the release upload', 'Publish zips, then the manifest', 'Clear the upload credentials']) {
      expect({ name, if: stepIf(stepNamed(name)) }).toEqual({ name, if: RELEASE_BUILT_HERE });
    }
    expect(stepNamed('Clear the upload credentials')).toContain(
      'for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do echo "$name=" >> "$GITHUB_ENV"; done',
    );
    expect(stepNamed('No AWS credentials while packages install')).toContain(
      'run: test -z "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}${AWS_SESSION_TOKEN:-}"',
    );
    expect(stepIf(stepNamed('No AWS credentials while packages install'))).toBeUndefined();
  });

  test('the diff credentials narrow the session; the deploy credentials do not', () => {
    const [, diffStep, deployStep] = deploySteps;
    expect(stepInput(diffStep, 'inline-session-policy')).toBeDefined();
    expect(stepInput(deployStep, 'inline-session-policy')).toBeUndefined();
    expect(stepInput(deployStep, 'managed-session-policies')).toBeUndefined();
  });

  test('the diff session policy keeps only reads and the bootstrap roles, each granted by the infra deploy role', () => {
    const policy = diffSessionPolicy();
    expect(policy.Version).toBe('2012-10-17');
    expect(JSON.stringify(policy).length).toBeLessThan(2048); // STS limit for an inline session policy
    for (const statement of policy.Statement) {
      expect(Object.keys(statement).sort()).toEqual(['Action', 'Effect', 'Resource', 'Sid']);
      expect(statement.Effect).toBe('Allow');
    }
    const actions = policy.Statement.flatMap((statement) => asArray(statement.Action));
    expect([...new Set(actions)].sort()).toEqual(['lambda:GetAlias', 's3:GetObject', 'sts:AssumeRole']);
    for (const statement of policy.Statement) {
      for (const action of asArray(statement.Action)) {
        for (const resource of asArray(statement.Resource)) {
          // A session policy only narrows: anything the role does not grant would silently not work.
          expect({ action, resource, granted: roleAllows(infraRole, action, resource) }).toEqual({ action, resource, granted: true });
        }
      }
    }
    expect(workflow).toContain(`ARTIFACTS_BUCKET: ${DEFAULT_LAMBDA_ARTIFACTS_BUCKET_NAME}\n`);
    expect(policy.Statement.filter((statement) => asArray(statement.Action).includes('s3:GetObject'))
      .flatMap((statement) => asArray(statement.Resource))).toEqual([`${BUCKET_ARN}/releases/*`]);
  });

  test("the diff session policy names exactly the bootstrap roles the app's cloud assembly has the CLI assume", () => {
    const { roles, additionalOptions } = bootstrapRolesOfApp();
    // Session tags would also need sts:TagSession, which neither the role nor the session policy grants.
    expect(additionalOptions).toEqual([]);
    expect(roles).toEqual(
      ['deploy-role', 'file-publishing-role', 'lookup-role'].map((name) => roleArn(`cdk-hnb659fds-${name}-${ACCOUNT}-${REGION}`)),
    );
    const assumable = diffSessionPolicy().Statement
      .filter((statement) => asArray(statement.Action).includes('sts:AssumeRole'))
      .flatMap((statement) => asArray(statement.Resource));
    expect([...assumable].sort()).toEqual(roles);
    for (const role of roles) {
      expect(roleAllows(infraRole, 'sts:AssumeRole', role)).toBe(true);
    }
  });

  test('every AWS call a diff run makes with the infra deploy role is inside the diff session policy', () => {
    const allowed = new Set(diffSessionPolicy().Statement.flatMap((statement) => asArray(statement.Action)));
    const steps = diffModeSteps();
    const direct = awsCallsIn(steps.join('\n'));
    expect(direct).toEqual(['s3:GetObject']);
    expect(direct.filter((action) => !allowed.has(action))).toEqual([]);
    // Its S3 reads stay under releases/, the session policy's only S3 resource.
    for (const path of steps.join('\n').matchAll(/s3:\/\/\$\{ARTIFACTS_BUCKET\}\/([^"\s]+)|\bkey="([^"]+)"/g)) {
      expect(path[1] ?? path[2]).toMatch(/^releases\//);
    }
    // npm scripts: the guard makes no AWS call; the alias pin dry run only reads aliases (next test).
    const scripts = [...steps.join('\n').matchAll(/npm run (release:[\w:-]+)([^\n]*)/g)].map(([, name, args]) => ({ name, args }));
    expect(scripts.map(({ name }) => name).sort()).toEqual(['release:check-deploy-guard', 'release:sync-prod-alias-versions']);
    for (const { name, args } of scripts.filter(({ name }) => name === 'release:sync-prod-alias-versions')) {
      expect({ name, args }).toEqual({ name, args: expect.stringContaining('--dry-run') });
    }
    expect(readFileSync(join(INFRA_ROOT, 'scripts', 'checkDeployGuard.ts'), 'utf8')).not.toMatch(/child_process|\baws\(/);
    // The CDK CLI only synthesizes and diffs, through the bootstrap roles of the previous test.
    expect([...steps.join('\n').matchAll(/npx cdk (\w+)/g)].map(([, command]) => command).sort()).toEqual(['diff', 'synth']);
    expect(allowed.has('sts:AssumeRole')).toBe(true);
  });

  test('the alias pin dry run of a diff run calls nothing but lambda get-alias', () => {
    const bin = mkdtempSync(join(tmpdir(), 'billboard-fake-aws-'));
    try {
      const log = join(bin, 'calls.log');
      writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho "$1 $2" >> '${log}'\necho 7\n`);
      chmodSync(join(bin, 'aws'), 0o755);
      execFileSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', 'scripts/syncLambdaAliasVersionParameters.ts', '--templates', appDirectory(), '--dry-run'],
        { cwd: INFRA_ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: 'pipe' },
      );
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      expect(calls.length).toBeGreaterThan(40);
      expect([...new Set(calls)]).toEqual(['lambda get-alias']);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("the upload's only AWS calls are publish-release.sh uploads, which the services release role grants", () => {
    const publish = stepNamed('Publish zips, then the manifest');
    expect(awsCallsIn(publish)).toEqual([]);
    expect(publish).toContain('working-directory: .\n');
    expect(publish).toContain('run: scripts/ci/publish-release.sh "$RUNNER_TEMP/release"');
    const script = readFileSync(join(INFRA_ROOT, '..', 'scripts', 'ci', 'publish-release.sh'), 'utf8');
    const calls = [...script.matchAll(/(?:^|[\s;&|(])aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)\s+(\S+)\s+(\S+)/gm)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, service, operation, source, destination] of calls) {
      expect({ service, operation, upload: !source.startsWith('"s3://') && destination.startsWith('"s3://${bucket}/') }).toEqual({
        service: 's3',
        operation: 'cp',
        upload: true,
      });
    }
    for (const key of ['artifacts/x.zip', 'releases/services-20261015-abcdef0/manifest.json', 'history/x.zip', 'x.zip']) {
      expect(roleAllows(servicesRole, 's3:PutObject', `${BUCKET_ARN}/${key}`)).toBe(true);
    }
  });
});

describe('deploy.yml runs the guard before any production write', () => {
  const stepIndex = (name: string): number => indexIn(deployJob, `- name: ${name}`);

  test('after the diff, in diff and deploy mode, before the alias pins and cdk deploy', () => {
    const guard = stepIndex('Block replacing or deleting stateful resources');
    expect(guard).toBeGreaterThan(stepIndex('Diff against production'));
    expect(guard).toBeLessThan(stepIndex('Show the alias pins a deploy would write'));
    expect(guard).toBeLessThan(stepIndex('Sync live Lambda alias version pins'));
    expect(guard).toBeLessThan(stepIndex('Deploy all stacks'));
    const step = deployJob.slice(guard, deployJob.indexOf('- name:', guard + 1));
    expect(step).not.toMatch(/^\s+if:/m);
    expect(step).toContain('npm run release:check-deploy-guard -- --diff "$RUNNER_TEMP/cdk-diff.txt" --templates cdk.out');
    // The dispatch input reaches the script through the environment, never pasted into the shell.
    expect(step).toContain('DEPLOY_GUARD_ALLOW: ${{ inputs.allow_replacements }}');
    expect(step).not.toMatch(/run:[^\n]*\$\{\{/);
  });

  test('the override is a dispatch input, so a push can never use it', () => {
    expect(raw).toMatch(/workflow_dispatch:\n\s+inputs:[\s\S]*allow_replacements:\n\s+description:/);
  });

  test('no run step pastes an expression into the shell', () => {
    expect(raw).not.toMatch(/^\s+run: [^\n]*\$\{\{/m);
    for (const step of stepsOf(deployJob)) {
      const run = step.slice(step.indexOf('run: |'));
      if (step.includes('run: |')) {
        expect({ step: step.split('\n')[0], expression: /\$\{\{/.test(run) }).toEqual({ step: step.split('\n')[0], expression: false });
      }
    }
  });
});

// CON-08: the deploy job waits for the CodeDeploy deployments (all in parallel, about 11 minutes) for at
// most 45 minutes, in a job of at most 180.
test('the release workflow waits at most 45 minutes for CodeDeploy, in a 180-minute job', () => {
  // The deploy job's own timeout is the first job-level timeout after its header.
  expect(deployJob.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]).toBe('180');
  expect(workflow.match(/release:deploy-lambdas -- [^\n]*/g)).toEqual([
    'release:deploy-lambdas -- --outputs cdk-outputs.json --timeout-minutes 45',
  ]);
  expect(stepIf(stepNamed('Move Lambda prod aliases with CodeDeploy'))).toBe(DEPLOY_ONLY);
});
