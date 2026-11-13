import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { awsCallsIn, credentialSteps, jobText, readWorkflow, stepIf, stepInput, stepRun, stepsOf } from './helpers/workflow-text';

/**
 * The production deploy workflow, .github/workflows/deploy.yml (docs/DEPLOYING.md): one job, `deploy`, holds all AWS
 * work in the `production` environment. It publishes the release with the services release role, clears those
 * credentials, installs, and only then takes the infra deploy role, narrowed for a diff run. A run given release_id
 * checks every zip of that release against its manifest before synth, the deploy guard runs before any production
 * write, and the CodeDeploy wait fits the job's timeout. workflows.test.ts checks the rules every workflow follows.
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
      .flatMap((statement) => asArray(statement.Resource))).toEqual([`${BUCKET_ARN}/releases/*`, `${BUCKET_ARN}/artifacts/*`]);
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
    // Its S3 reads stay inside the session policy's S3 resources, the release manifests (releases/) and the release
    // zips (artifacts/), and the role grants each one.
    const prefixes = diffSessionPolicy().Statement
      .filter((statement) => asArray(statement.Action).includes('s3:GetObject'))
      .flatMap((statement) => asArray(statement.Resource))
      .map((resource) => resource.replace(`${BUCKET_ARN}/`, '').replace(/\*$/, ''));
    expect(prefixes).toEqual(['releases/', 'artifacts/']);
    const paths = [...steps.join('\n').matchAll(/s3:\/\/\$\{ARTIFACTS_BUCKET\}\/([^"\s]+)|\bkey="([^"]+)"/g)]
      .map((match) => match[1] ?? match[2]);
    expect(paths).toEqual(expect.arrayContaining(['releases/${BILLBOARD_RELEASE_ID}/manifest.json', 'artifacts/${name}/${sum}.zip']));
    for (const path of paths) {
      const object = `${BUCKET_ARN}/${path.replace(/\$\{\w+\}/g, 'x')}`;
      expect({ path, inPolicy: prefixes.some((prefix) => path.startsWith(prefix)), granted: roleAllows(infraRole, 's3:GetObject', object) })
        .toEqual({ path, inPolicy: true, granted: true });
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

describe('deploy.yml checks every zip of a release_id run against its manifest before synth', () => {
  const ZIP_CHECK = 'Check every release zip against the manifest';
  const RELEASE_GIVEN = "env.EXISTING_RELEASE_ID != ''";

  test('for a run given release_id, with the deploy role, after the manifest download and before synth; its only call is a download', () => {
    const step = stepNamed(ZIP_CHECK);
    expect(stepIf(step)).toBe(RELEASE_GIVEN);
    expect(diffModeSteps()).toContain(step);
    const check = indexIn(deployJob, `name: ${ZIP_CHECK}\n`);
    expect(check).toBeGreaterThan(indexIn(deployJob, 'name: Download the release manifest\n'));
    expect(check).toBeLessThan(indexIn(deployJob, 'name: Synthesize'));
    expect(awsCallsIn(step)).toEqual(['s3:GetObject']);
  });

  // An IAM change applies only once a run's cdk deploy has deployed GitHubOidcStack. A run that needed the deploy
  // role's artifacts/ read could not deploy that grant, or a fix to it.
  test('a run that builds its release reads nothing under artifacts/ with the deploy role', () => {
    const steps = stepsOf(deployJob);
    const fresh = steps.slice(steps.findIndex((step) => step.includes('name: AWS credentials for a diff')))
      .filter((step) => stepIf(step) !== RELEASE_GIVEN);
    expect(fresh.length).toBeGreaterThan(5);
    const paths = [...fresh.join('\n').matchAll(/s3:\/\/\$\{ARTIFACTS_BUCKET\}\/([^"\s]+)|\bkey="([^"]+)"/g)]
      .map((match) => match[1] ?? match[2]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !path.startsWith('releases/'))).toEqual([]);
  });

  describe('the step, run with a fake CLI over a local bucket', () => {
    const BUCKET = DEFAULT_LAMBDA_ARTIFACTS_BUCKET_NAME;
    const RELEASE_ID = 'services-20261112-abcdef0';
    const script = stepRun(stepNamed(ZIP_CHECK));
    const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');
    type Artifact = { logicalName: string; s3Key: string; sha256: string; s3ObjectVersion?: string };
    const artifactOf = (logicalName: string, content: string): Artifact =>
      ({ logicalName, s3Key: `artifacts/${logicalName}/${sha256(content)}.zip`, sha256: sha256(content) });
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'billboard-zip-check-'));
      for (const name of ['bin', 'bucket', 'temp']) {
        mkdirSync(join(dir, name));
      }
      // Copies s3://<bucket>/<key> from bucket/<key>, as a 403 when it is not there; logs every call.
      writeFileSync(join(dir, 'bin', 'aws'), [
        '#!/bin/sh',
        `echo "$*" >> '${join(dir, 'calls.log')}'`,
        `[ "$1 $2" = "s3 cp" ] || exit 2`,
        `case "$3" in "s3://${BUCKET}/"*) ;; *) exit 2;; esac`,
        `src='${join(dir, 'bucket')}'/"\${3#s3://${BUCKET}/}"`,
        `[ -f "$src" ] || { echo 'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden' >&2; exit 1; }`,
        'cp "$src" "$4"',
        '',
      ].join('\n'));
      chmodSync(join(dir, 'bin', 'aws'), 0o755);
      // GitHub's Ubuntu runners have sha256sum; older macOS has only shasum, which prints the same.
      if (spawnSync('sh', ['-c', 'command -v sha256sum'], { stdio: 'ignore' }).status !== 0) {
        writeFileSync(join(dir, 'bin', 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n');
        chmodSync(join(dir, 'bin', 'sha256sum'), 0o755);
      }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const upload = (key: string, content: string): void => {
      mkdirSync(join(dir, 'bucket', key, '..'), { recursive: true });
      writeFileSync(join(dir, 'bucket', key), content);
    };
    const download = (s3Key: string): string =>
      `s3 cp s3://${BUCKET}/${s3Key} ${join(dir, 'temp', 'release-zip-check', s3Key.split('/')[2])} --only-show-errors`;

    /** Runs the step over these artifacts, or over this manifest text. */
    const run = (manifest: Artifact[] | string): { status: number | null; output: string; summary: string; calls: string[] } => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify({ schemaVersion: 1, artifacts: manifest }));
      const summary = join(dir, 'summary.md');
      writeFileSync(join(dir, 'step.sh'), script);
      const result = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: join(dir, 'temp'),
          ARTIFACTS_BUCKET: BUCKET,
          BILLBOARD_RELEASE_ID: RELEASE_ID,
          BILLBOARD_RELEASE_MANIFEST_FILE: file,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        summary: read(summary),
        calls: read(join(dir, 'calls.log')).trim().split('\n').filter(Boolean),
      };
    };
    const failedLine = (failed: number, total: number): string =>
      `::error title=Release zip check::${failed} of ${total} zips of release ${RELEASE_ID} failed the check (errors above). Nothing has been deployed.`;

    test('passes when every zip is there with its hash, downloading each one once', () => {
      const artifacts = [artifactOf('fnA', 'zip A'), artifactOf('fnB', 'zip B')];
      upload(artifacts[0].s3Key, 'zip A');
      upload(artifacts[1].s3Key, 'zip B');
      const result = run(artifacts);
      expect(result).toEqual(expect.objectContaining({ status: 0, summary: 'Release zips checked against the manifest: 2\n' }));
      expect(result.output).not.toContain('::error');
      expect(result.calls).toEqual(artifacts.map(({ s3Key }) => download(s3Key)));
    });

    test('fails, naming the artifact, when a zip was replaced, and still checks the rest', () => {
      const artifacts = [artifactOf('fnA', 'zip A'), artifactOf('fnB', 'zip B')];
      upload(artifacts[0].s3Key, 'another zip A');
      upload(artifacts[1].s3Key, 'zip B');
      const result = run(artifacts);
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `::error title=Release zip changed::fnA: s3://${BUCKET}/${artifacts[0].s3Key} has SHA-256 ${sha256('another zip A')}, ` +
          `not the manifest's ${artifacts[0].sha256}`,
      );
      expect(result.output).toContain(failedLine(1, 2));
      expect(result.calls).toEqual(artifacts.map(({ s3Key }) => download(s3Key)));
      expect(result.summary).toBe('Release zip check: 1 of 2 zips failed: fnA\n');
    });

    test('fails, naming the artifact, when a zip is missing', () => {
      const artifacts = [artifactOf('fnA', 'zip A'), artifactOf('fnB', 'zip B')];
      upload(artifacts[1].s3Key, 'zip B');
      const result = run(artifacts);
      expect(result.status).toBe(1);
      expect(result.output).toContain('(403) when calling the HeadObject operation');
      expect(result.output).toContain(`::error title=Release zip missing::fnA: s3://${BUCKET}/${artifacts[0].s3Key} is missing or unreadable`);
      expect(result.output).toContain(failedLine(1, 2));
      expect(result.calls).toHaveLength(2);
    });

    test('names every bad zip in one run', () => {
      const artifacts = [artifactOf('fnA', 'zip A'), artifactOf('fnB', 'zip B'), artifactOf('fnC', 'zip C'), artifactOf('fnD', 'zip D')];
      upload(artifacts[0].s3Key, 'another zip A');
      upload(artifacts[2].s3Key, 'zip C');
      upload(artifacts[3].s3Key, 'another zip D');
      const result = run(artifacts);
      expect(result.status).toBe(1);
      expect(result.output.match(/^::error title=Release zip (changed|missing)::(\w+): /gm)).toEqual([
        '::error title=Release zip changed::fnA: ',
        '::error title=Release zip missing::fnB: ',
        '::error title=Release zip changed::fnD: ',
      ]);
      expect(result.output).toContain(failedLine(3, 4));
      expect(result.summary).toBe('Release zip check: 3 of 4 zips failed: fnA fnB fnD\n');
    });

    test.each<[string, (artifact: Artifact) => Artifact, string]>([
      ['a key that is not content-addressed', (artifact) => ({ ...artifact, s3Key: 'releases/r1/fnB.zip' }), 'Release zip key'],
      ['a key that holds another hash', (artifact) => ({ ...artifact, s3Key: `artifacts/fnB/${'b'.repeat(64)}.zip` }), 'Release zip key'],
      ['a hash that is not one', (artifact) => ({ ...artifact, sha256: 'B'.repeat(64), s3Key: `artifacts/fnB/${'B'.repeat(64)}.zip` }), 'Release zip key'],
      ['a pinned object version', (artifact) => ({ ...artifact, s3ObjectVersion: 'v1' }), 'Release zip version'],
    ])('fails, without downloading that zip, for %s', (_case, change, title) => {
      const artifacts = [change(artifactOf('fnB', 'zip B')), artifactOf('fnA', 'zip A')];
      upload(artifacts[0].s3Key, 'zip B');
      upload(artifacts[1].s3Key, 'zip A');
      const result = run(artifacts);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`::error title=${title}::fnB: `);
      expect(result.output).toContain(failedLine(1, 2));
      expect(result.calls).toEqual([download(artifacts[1].s3Key)]);
    });

    // Each of these would pass a check that read the list leniently: bash's read merges empty tab-separated fields.
    const zipA = artifactOf('fnA', 'zip A');
    test.each<[string, string, string]>([
      ['no artifacts', JSON.stringify({ schemaVersion: 1, artifacts: [] }), 'its artifacts are not a non-empty array'],
      ['no artifacts list', JSON.stringify({ schemaVersion: 1 }), 'its artifacts are not a non-empty array'],
      ['artifacts that are an object', JSON.stringify({ schemaVersion: 1, artifacts: { fnA: zipA } }), 'its artifacts are not a non-empty array'],
      ['two JSON documents', `${JSON.stringify({ schemaVersion: 1, artifacts: [zipA] })}\n${JSON.stringify({ artifacts: [] })}`, 'it is not one JSON document'],
      [
        'an empty logicalName, which would shift the fields after it',
        JSON.stringify({ schemaVersion: 1, artifacts: [{ logicalName: '', s3Key: 'fnA', sha256: zipA.s3Key, s3ObjectVersion: zipA.sha256 }] }),
        'an artifact has no logicalName, s3Key or sha256 string',
      ],
      ['a sha256 that is not a string', JSON.stringify({ schemaVersion: 1, artifacts: [{ ...zipA, sha256: 1 }] }), 'an artifact has no logicalName, s3Key or sha256 string'],
    ])('fails, downloading nothing, for a manifest with %s', (_case, manifest, reason) => {
      upload(zipA.s3Key, 'zip A');
      const result = run(manifest);
      expect(result.status).toBe(1);
      expect(result.output).toMatch(new RegExp(
        `^::error title=Release zip check::the manifest of release ${RELEASE_ID} cannot be checked: jq: error \\(at [^\\n]*\\): ${reason} $`, 'm'));
      expect(result.calls).toEqual([]);
      expect(result.summary).toBe('');
    });
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
