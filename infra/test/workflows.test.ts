import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobText, readWorkflow, REPOSITORY_ROOT } from './helpers/workflow-text';

/**
 * Rules every workflow in .github/workflows follows, so that a public pull request cannot reach a secret, a cloud
 * role or a machine of the project's (docs/DEPLOYING.md):
 *   - every job runs on a GitHub-hosted runner;
 *   - the only triggers are pull_request, push and workflow_dispatch;
 *   - `id-token: write` (the OIDC token AWS trusts) and secrets appear only in deploy.yml's `deploy` job, which runs
 *     in the production environment and only for a manual run on main;
 *   - the default token is read-only, and every action is pinned to a full commit SHA.
 * And the commit-safety check of pr.yml (scripts/ci/check-commit-identities.sh) passes only allowed addresses.
 */
const WORKFLOWS = readdirSync(join(REPOSITORY_ROOT, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name)).sort();
const ALLOWED_TRIGGERS = ['pull_request', 'push', 'workflow_dispatch'];
/**
 * The repository's Actions policy (Settings > Actions > General: selected actions, SHA pinning required) allows
 * GitHub's own actions (actions/*, github/*) and, of all others, only these exact commits. A workflow that uses
 * anything else is not started at all (startup_failure), and a pull request's checks cannot show that, so change
 * the policy and this list together.
 */
const POLICY_ALLOWED_ACTIONS = ['aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a'];

/** The keys of a top-level block (two spaces in), such as `on:` or `jobs:`. */
const blockKeys = (workflow: string, block: string): string[] => {
  const start = workflow.indexOf(`\n${block}:\n`);
  expect({ block, found: start >= 0 }).toEqual({ block, found: true });
  const rest = workflow.slice(start + block.length + 3);
  const end = rest.search(/\n[A-Za-z]/);
  const body = end < 0 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^ {2}([A-Za-z_][\w-]*):/gm)].map(([, key]) => key);
};

describe('every workflow', () => {
  test('there are exactly the two workflows this test knows', () => {
    expect(WORKFLOWS).toEqual(['deploy.yml', 'pr.yml']);
  });

  test.each(WORKFLOWS)('%s runs every job on a GitHub-hosted runner', (name) => {
    const workflow = readWorkflow(name);
    const labels = [...workflow.matchAll(/^\s+runs-on:\s*(.+?)\s*$/gm)].map(([, label]) => label);
    expect(labels.length).toBe(blockKeys(workflow, 'jobs').length);
    for (const label of labels) {
      expect({ label, hosted: /^(?:ubuntu|macos|windows)-[\w.]+$/.test(label) }).toEqual({ label, hosted: true });
    }
    expect(workflow).not.toMatch(/self-hosted|vars\.\w*RUNNER/);
  });

  test.each(WORKFLOWS)('%s is started only by pull_request, push or workflow_dispatch', (name) => {
    const workflow = readWorkflow(name);
    expect(workflow).toMatch(/^on:\n/m);
    const triggers = blockKeys(workflow, 'on');
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.filter((trigger) => !ALLOWED_TRIGGERS.includes(trigger))).toEqual([]);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run|repository_dispatch|issue_comment/);
  });

  test.each(WORKFLOWS)('%s gives the default token read access only, and pins every action to a commit SHA', (name) => {
    const workflow = readWorkflow(name);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    for (const [, action] of workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
      expect({ action, pinned: /@[0-9a-f]{40}$/.test(action) }).toEqual({ action, pinned: true });
    }
    // The only write permission anywhere is id-token: write, in deploy.yml's deploy job (next test).
    expect([...workflow.matchAll(/^\s+([\w-]+): write$/gm)].map(([, scope]) => scope).filter((scope) => scope !== 'id-token')).toEqual([]);
  });

  test.each(WORKFLOWS)("%s uses, besides GitHub's own actions, only commits the repository's policy allows", (name) => {
    const workflow = readWorkflow(name);
    const others = [...workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)]
      .map(([, action]) => action)
      .filter((action) => !/^(?:actions|github)\//.test(action));
    expect(others.filter((action) => !POLICY_ALLOWED_ACTIONS.includes(action))).toEqual([]);
  });

  test("id-token: write and secrets appear only in deploy.yml's deploy job, in production, on main", () => {
    for (const name of WORKFLOWS) {
      const workflow = readWorkflow(name);
      const tokens = workflow.match(/id-token: write/g) ?? [];
      const secrets = workflow.match(/\$\{\{\s*secrets\./g) ?? [];
      if (name !== 'deploy.yml') {
        expect({ name, tokens: tokens.length, secrets: secrets.length }).toEqual({ name, tokens: 0, secrets: 0 });
      }
    }
    const deploy = readWorkflow('deploy.yml');
    const job = jobText(deploy, 'deploy');
    expect(deploy.match(/id-token: write/g)).toHaveLength(1);
    expect(job).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/m);
    expect(job).toMatch(/^ {4}environment: production$/m);
    expect((deploy.match(/\$\{\{\s*secrets\./g) ?? []).length).toBe((job.match(/\$\{\{\s*secrets\./g) ?? []).length);
    // It runs only when the plan job chose diff or deploy, which only a manual run on main does.
    expect(job).toMatch(/^ {4}if: needs\.plan\.outputs\.mode != 'off'/m);
    expect(blockKeys(deploy, 'on').sort()).toEqual(['push', 'workflow_dispatch']);
    expect(deploy).toMatch(/^ {2}push:\n {4}branches: \[main\]\n/m);
    expect(jobText(deploy, 'plan')).toContain(
      'if [ "$GITHUB_REF" = "refs/heads/main" ] && [ "$EVENT_NAME" = "workflow_dispatch" ]; then mode="$INPUT_MODE"',
    );
  });

  test('pr.yml checks every pull request, with no path filter, and runs the commit-safety check', () => {
    const pr = readWorkflow('pr.yml');
    expect(pr).not.toContain('paths-ignore');
    expect(pr).not.toContain('paths:');
    expect(blockKeys(pr, 'jobs')).toEqual(['verify', 'commit-safety']);
    expect(jobText(pr, 'verify')).toContain('run: npm run verify\n');
    const safety = jobText(pr, 'commit-safety');
    expect(safety).toContain('fetch-depth: 0');
    expect(safety).toContain('run: bash scripts/ci/install-gitleaks.sh "$RUNNER_TEMP/bin"');
    // -m: merges are scanned as their diff against each parent, so a conflict resolution cannot carry a secret past it.
    expect(safety).toContain('--log-opts="-m $RANGE" --config .gitleaks.toml');
    expect(safety).toContain('run: bash scripts/ci/check-commit-identities.sh "$RANGE"');
  });
});

describe('scripts/ci/check-commit-identities.sh', () => {
  const script = join(REPOSITORY_ROOT, 'scripts', 'ci', 'check-commit-identities.sh');
  let repo: string;
  let count = 0;

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });

  /** A commit with these identities and message; its SHA. */
  const commit = (author: string, committer = author, message = 'Changing a file'): string => {
    count += 1;
    writeFileSync(join(repo, 'file.txt'), `${count}\n`);
    git('add', 'file.txt');
    execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Someone',
        GIT_AUTHOR_EMAIL: author,
        GIT_COMMITTER_NAME: 'Someone',
        GIT_COMMITTER_EMAIL: committer,
      },
    });
    return git('rev-parse', 'HEAD').trim();
  };

  const check = (range: string): { status: number | null; output: string } => {
    const result = spawnSync('bash', [script, range], { cwd: repo, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'billboard-identities-'));
    git('init', '-q', '-b', 'main');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('passes noreply, web-flow, project and AI co-author addresses', () => {
    const base = commit('contact@billboard-project.com');
    commit('12345+someone@users.noreply.github.com', 'noreply@github.com');
    commit('someone@users.noreply.github.com');
    commit('49699333+dependabot[bot]@users.noreply.github.com');
    const head = commit(
      'contact@billboard-project.com',
      'contact@billboard-project.com',
      'Changing a file\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    );
    expect(check(`${base}..${head}`)).toEqual({ status: 0, output: 'check-commit-identities: ok (4 commits)\n' });
    expect(check(head).status).toBe(0);
  });

  test.each([
    ['an author', ['someone@example.com', '1+someone@users.noreply.github.com'], 'author address not allowed: s***@e***.com'],
    ['a committer', ['1+someone@users.noreply.github.com', 'someone@example.com'], 'committer address not allowed: s***@e***.com'],
  ])('fails %s address that is not allowed, and masks it', (_label, [author, committer], line) => {
    const base = commit('contact@billboard-project.com');
    const head = commit(author, committer);
    const result = check(`${base}..${head}`);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${head.slice(0, 7)}`);
    expect(result.output).toContain(line);
    expect(result.output).not.toContain('someone@example.com');
  });

  test('fails a trailer or any other address in the message that is not allowed', () => {
    const base = commit('contact@billboard-project.com');
    const head = commit(
      '1+someone@users.noreply.github.com',
      '1+someone@users.noreply.github.com',
      'Changing a file\n\nSigned-off-by: Someone <someone@example.org>',
    );
    const result = check(`${base}..${head}`);
    expect(result.status).toBe(1);
    expect(result.output).toContain('address in the commit message not allowed: s***@e***.org');
  });

  test('checks only the range it is given, and fails on a range it cannot read', () => {
    const base = commit('someone@example.com');
    const head = commit('contact@billboard-project.com');
    expect(check(`${base}..${head}`).status).toBe(0);
    expect(check(head).status).toBe(1);
    expect(check('no-such-ref..HEAD').status).toBe(2);
  });
});
