import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateDeployGuard,
  parseAllowList,
  parseCdkDiff,
  runDeployGuard,
  synthesizedStackNames,
} from '../scripts/checkDeployGuard';
import { synthesizedAppManifest } from './helpers/synth-app';

/**
 * Infra review item 5b: deploy.yml runs scripts/checkDeployGuard.ts on its `cdk diff` output and stops
 * before any production write when a stateful resource would be replaced or deleted.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'deploy-guard', name), 'utf8');

// The switchover U9 diff, recorded offline from this branch's synth and the live templates (see the
// fixture's header): it replaces only the two manifest queues and their mappings.
const U9_DIFF = fixture('u9-like-cdk-diff.txt');
// One stack of that diff exactly as cdk prints it: IAM table, property lines and summary.
const FULL_FORMAT = fixture('congress-store-full-format.txt');

/** The U9 diff with `line` added to the end of `stack`'s section. */
const withLineInStack = (stack: string, line: string): string =>
  U9_DIFF.replace(new RegExp(`(^Stack ${stack}\\n)`, 'm'), `$1${line}\n`);

/** The 15 stacks the app synthesizes, in the order cdk diff prints them (checked against the real synth below). */
const APP_STACKS = [
  'SharedInfraStack',
  // REL-54: created right after SharedInfraStack, so cdk deploys it before the service stacks.
  'EmailStack',
  'CongressIntegrationServiceStack',
  'PriorityServiceStack',
  'UserAPIServiceStack',
  'ShareSiteStack',
  'NotificationServiceStack',
  'SummarizerServiceStack',
  'UserStoreStack',
  'AnalyticsServiceStack',
  'CongressStoreStack',
  'AggregateDataStoreStack',
  'MonitoringStack',
  'GitHubOidcStack',
  'SecurityBaselineStack',
];

/** A cdk.out/manifest.json shaped like the CLI's: each stack beside its asset manifest, plus the tree. */
const assemblyManifest = (stacks: readonly string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: '48.0.0',
    artifacts: {
      ...Object.fromEntries(
        stacks.flatMap((name) => [
          [`${name}.assets`, { type: 'cdk:asset-manifest', properties: { file: `${name}.assets.json` } }],
          [name, { type: 'aws:cloudformation:stack', properties: { templateFile: `${name}.template.json` } }],
        ]),
      ),
      Tree: { type: 'cdk:tree', properties: { file: 'tree.json' } },
      ...extra,
    },
  });

const run = (text: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}, stacks: readonly string[] = APP_STACKS) => {
  const lines: string[] = [];
  const summaries: string[] = [];
  const exitCode = runDeployGuard({
    argv: ['--diff', 'cdk-diff.txt', '--templates', 'cdk.out', ...argv],
    env,
    readFile: (path) => (path === join('cdk.out', 'manifest.json') ? assemblyManifest(stacks) : text),
    log: (line) => lines.push(line),
    appendSummary: (markdown) => summaries.push(markdown),
  });
  return { exitCode, output: lines.join('\n'), summary: summaries.join('') };
};

describe('deploy guard: parsing cdk diff output', () => {
  test('reads stack headers and resource lines, with path, logical id and impact', () => {
    const { stacks, changes } = parseCdkDiff(FULL_FORMAT);
    expect(stacks).toEqual(['CongressStoreStack']);
    expect(changes.find((change) => change.logicalId === 'BillsManifestQueue8FD11A10')).toEqual({
      stack: 'CongressStoreStack',
      marker: '~',
      type: 'AWS::SQS::Queue',
      logicalId: 'BillsManifestQueue8FD11A10',
      path: 'BillsManifestQueue',
      impact: 'replace',
      lineNumber: 151,
    });
    expect(changes.find((change) => change.logicalId === 'CreateBillsManifestCurrentVersion74042E27e13d73d9990fe03bee8c4f48db51bece'))
      .toMatchObject({ marker: '-', type: 'AWS::Lambda::Version', impact: 'orphan' });
    expect(changes.find((change) => change.logicalId === 'BillStoreBucket43246214')).toMatchObject({
      marker: '~',
      type: 'AWS::S3::Bucket',
      impact: 'update',
    });
    // IAM table rows, property lines and the summary line are not resource changes.
    expect(changes.every((change) => /^(AWS|Custom)::/.test(change.type))).toBe(true);
  });

  test('strips colour codes and reads a line with no construct path', () => {
    const colored = 'Stack S\n\u001b[33m[~]\u001b[39m \u001b[36mAWS::S3::Bucket\u001b[39m Bucket83908E77 \u001b[1mreplace\u001b[22m\n';
    expect(parseCdkDiff(colored).changes).toEqual([
      { stack: 'S', marker: '~', type: 'AWS::S3::Bucket', logicalId: 'Bucket83908E77', impact: 'replace', lineNumber: 2 },
    ]);
  });

  test('a property line that requires replacement raises the impact even when the resource line says nothing', () => {
    const text = [
      'Stack UserAPIServiceStack',
      'Resources',
      '[~] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD',
      ' ├─ [~] MfaConfiguration',
      ' │   ├─ [-] OPTIONAL',
      ' │   └─ [+] ON',
      ' └─ [~] UsernameAttributes (requires replacement)',
      '     └─ [+] ["phone_number"]',
      '[~] AWS::S3::Bucket SyntheticsArtifactsBucket SyntheticsArtifactsBucketD0DC82F9',
      ' └─ [~] BucketName (may cause replacement)',
      '[~] AWS::SQS::Queue Q Q1234ABCD',
      ' └─ [~] VisibilityTimeout',
    ].join('\n');
    expect(parseCdkDiff(text).changes.map((change) => [change.logicalId, change.impact])).toEqual([
      ['BillboardUserPoolC41FE3DD', 'replace'],
      ['SyntheticsArtifactsBucketD0DC82F9', 'may be replaced'],
      ['Q1234ABCD', 'update'],
    ]);
  });

  test('an impact word the guard does not know is treated as the worst case', () => {
    const { changes } = parseCdkDiff('Stack S\n[~] AWS::DynamoDB::Table T T1234 will-be-recreated\n');
    expect(changes[0]).toMatchObject({ logicalId: 'will-be-recreated', impact: 'unknown' });
    expect(evaluateDeployGuard('Stack S\n[~] AWS::DynamoDB::Table T T1234 will-be-recreated\n').blocked).toHaveLength(1);
  });
});

describe('deploy guard: the recorded U9 diff', () => {
  test('passes, with the manifest queue and mapping replacements as warnings', () => {
    const result = evaluateDeployGuard(U9_DIFF);
    expect(result.stacks).toHaveLength(15);
    expect(result.blocked).toEqual([]);
    expect(result.warnings.map((finding) => finding.resource).sort()).toEqual([
      'CongressStoreStack/BillsManifestQueue8FD11A10',
      'CongressStoreStack/CongressMembersManifestQueueB11B857A',
      'CongressStoreStack/CreateBillsManifestProdAliasSqsEventSourceCongressStoreStackBillsManifestQueue0EF854481B7024CE',
      'CongressStoreStack/CreateCongressMembersManifestProdAliasSqsEventSourceCongressStoreStackCongressMembersManifestQueue99A91B98954C8603',
    ]);
  });

  test('U9 updates the protected resources in place and leaves the poller cursor alone', () => {
    const { changes } = parseCdkDiff(U9_DIFF);
    const byId = (logicalId: string) => changes.filter((change) => change.logicalId === logicalId);
    expect(byId('BillboardUserPoolC41FE3DD')).toEqual([expect.objectContaining({ impact: 'update' })]);
    expect(byId('BillboardUserPoolUserPoolClient61DEF7CD')).toEqual([expect.objectContaining({ impact: 'update' })]);
    expect(byId('UserFeedbackTableAC038F20')).toEqual([expect.objectContaining({ impact: 'update' })]);
    expect(byId('BillStatsAggregatorFeedbackStream05D8A0E8')).toEqual([expect.objectContaining({ impact: 'update' })]);
    expect(changes.filter((change) => change.type === 'AWS::SSM::Parameter')).toEqual([]);
  });

  test('the CLI exits 0 and writes a passing summary', () => {
    const { exitCode, output, summary } = run(U9_DIFF, [], { GITHUB_ACTIONS: 'true' });
    expect(exitCode).toBe(0);
    expect(output).toContain('::warning title=Deploy guard::CongressStoreStack/BillsManifestQueue8FD11A10');
    expect(output).not.toContain('::error');
    expect(summary).toContain('Passed: no stateful resource is replaced or deleted (15 stacks).');
  });
});

describe('deploy guard: blocked changes', () => {
  test('a made-up user pool replacement fails the deploy', () => {
    const replaced = U9_DIFF.replace(
      /^\[~\] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD$/m,
      '[~] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD replace',
    );
    expect(replaced).not.toBe(U9_DIFF);
    const { exitCode, output, summary } = run(replaced, [], { GITHUB_ACTIONS: 'true' });
    expect(exitCode).toBe(1);
    expect(output).toMatch(
      /::error title=Deploy guard::UserAPIServiceStack\/BillboardUserPoolC41FE3DD \(AWS::Cognito::UserPool, diff line \d+\): AWS::Cognito::UserPool would be replaced/,
    );
    expect(summary).toContain('**Blocked**: 1 change(s)');
  });

  test.each([
    ['a possibly replaced app client', 'UserAPIServiceStack', '[~] AWS::Cognito::UserPoolClient BillboardUserPool/UserPoolClient BillboardUserPoolUserPoolClient61DEF7CD may be replaced'],
    ['a deleted table', 'UserStoreStack', '[-] AWS::DynamoDB::Table UserFeedbackTable UserFeedbackTableAC038F20 destroy'],
    ['an orphaned (removed, retained) table', 'CongressStoreStack', '[-] AWS::DynamoDB::Table BillManifestTable BillManifestTable027DB807 orphan'],
    ['a replaced bucket', 'CongressStoreStack', '[~] AWS::S3::Bucket BillStoreBucket BillStoreBucket43246214 replace'],
    ['a replaced secret', 'UserAPIServiceStack', '[~] AWS::SecretsManager::Secret DistrictVerificationHashSaltSecret DistrictVerificationHashSaltSecret54008A38 replace'],
    ['a replaced feedback stream mapping', 'AnalyticsServiceStack', '[~] AWS::Lambda::EventSourceMapping BillStatsAggregatorFeedbackStream BillStatsAggregatorFeedbackStream05D8A0E8 replace'],
    ['a deleted feedback stream mapping', 'AnalyticsServiceStack', '[-] AWS::Lambda::EventSourceMapping BillStatsAggregatorFeedbackStream BillStatsAggregatorFeedbackStream05D8A0E8 destroy'],
    ['any update of the poller cursor parameter', 'CongressIntegrationServiceStack', '[~] AWS::SSM::Parameter BillsApiPollerStateParameter BillsApiPollerStateParameterC64331E8'],
    ['a removed poller cursor parameter', 'CongressIntegrationServiceStack', '[-] AWS::SSM::Parameter BillsApiPollerStateParameter BillsApiPollerStateParameterC64331E8 destroy'],
    // REL-46: the 120th's cursor, covered by the same id prefix.
    ['any update of the 120th cursor parameter', 'CongressIntegrationServiceStack', '[~] AWS::SSM::Parameter BillsApiPollerStateParameter120 BillsApiPollerStateParameter1206B406681'],
    ['a removed 120th cursor parameter', 'CongressIntegrationServiceStack', '[-] AWS::SSM::Parameter BillsApiPollerStateParameter120 BillsApiPollerStateParameter1206B406681 destroy'],
    // REL-54: a new identity has new DKIM keys to verify, and step 2's user pool sends its codes through it.
    ['a deleted SES email identity', 'EmailStack', '[-] AWS::SES::EmailIdentity EmailIdentity EmailIdentity7187767D destroy'],
    ['a replaced SES email identity', 'EmailStack', '[~] AWS::SES::EmailIdentity EmailIdentity EmailIdentity7187767D replace'],
  ])('%s fails the deploy', (_name, stack, line) => {
    const result = evaluateDeployGuard(withLineInStack(stack, line));
    expect(result.blocked.map((finding) => finding.resource)).toEqual([`${stack}/${line.split(' ')[3]}`]);
    expect(run(withLineInStack(stack, line)).exitCode).toBe(1);
  });

  test.each([
    ['an updated table', '[~] AWS::DynamoDB::Table T T1234ABCD'],
    ['a new bucket', '[+] AWS::S3::Bucket B B1234ABCD'],
    ['an imported table', '[←] AWS::DynamoDB::Table T T1234ABCD import'],
    ['a replaced queue (warning only)', '[~] AWS::SQS::Queue Q Q1234ABCD replace'],
    ['a replaced SQS mapping (warning only)', '[~] AWS::Lambda::EventSourceMapping F/SqsEventSource F1234ABCD replace'],
    ['a different SSM parameter', '[~] AWS::SSM::Parameter Other Other1234ABCD'],
    ['a new poller cursor parameter', '[+] AWS::SSM::Parameter BillsApiPollerStateParameter BillsApiPollerStateParameterC64331E8'],
    ['the new 120th cursor parameter (REL-46)', '[+] AWS::SSM::Parameter BillsApiPollerStateParameter120 BillsApiPollerStateParameter1206B406681'],
    ['an updated SES email identity (its DKIM, MAIL FROM or configuration set)', '[~] AWS::SES::EmailIdentity EmailIdentity EmailIdentity7187767D'],
    ['a replaced DKIM record', '[~] AWS::Route53::RecordSet DkimRecord1 DkimRecord1 replace'],
  ])('%s does not block', (_name, line) => {
    expect(evaluateDeployGuard(withLineInStack('SharedInfraStack', line)).blocked).toEqual([]);
  });

  test('a diff with no differences passes', () => {
    expect(run('Stack SharedInfraStack\nThere were no differences\n', [], {}, ['SharedInfraStack']).exitCode).toBe(0);
  });
});

// REL-54 step 2: the user pool starts sending through SES. Its real cdk diff against the live template (recorded in
// the fixture) is an in-place update the guard lets through; the same pool line with a replacing property is blocked,
// so a step 2 that replaced the pool, and with it every account, could not deploy from a push.
describe('deploy guard: REL-54 step 2 updates the user pool in place', () => {
  const STEP2_POOL_DIFF = fixture('rel54-step2-user-pool-diff.txt');
  const POOL_LINE = /^\[~\] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD$/m;

  test('the recorded diff is one in-place update of the pool, with exactly the four email properties', () => {
    const { stacks, changes } = parseCdkDiff(STEP2_POOL_DIFF);
    expect(stacks).toEqual(['UserAPIServiceStack']);
    expect(changes).toEqual([
      expect.objectContaining({
        marker: '~',
        type: 'AWS::Cognito::UserPool',
        logicalId: 'BillboardUserPoolC41FE3DD',
        impact: 'update',
      }),
    ]);
    const properties = STEP2_POOL_DIFF.split('\n')
      .map((line) => /^ [├└]─ \[([+~-])\] (\w+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(([, marker, name]) => `${marker} ${name}`);
    expect(properties).toEqual([
      '+ EmailConfiguration',
      '~ EmailVerificationMessage',
      '~ EmailVerificationSubject',
      '~ VerificationMessageTemplate',
    ]);
    expect(STEP2_POOL_DIFF).not.toMatch(/replace|replacement|destroy|orphan/);
  });

  test('passes the guard', () => {
    const result = evaluateDeployGuard(STEP2_POOL_DIFF, [], ['UserAPIServiceStack']);
    expect(result.blocked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test.each([
    ['the resource line says replace', (text: string) => text.replace(POOL_LINE, (line) => `${line} replace`)],
    ['the resource line says may be replaced', (text: string) => text.replace(POOL_LINE, (line) => `${line} may be replaced`)],
    ['a property requires replacement', (text: string) => text.replace(' ├─ [+] EmailConfiguration', ' ├─ [+] EmailConfiguration (requires replacement)')],
    ['a property may cause replacement', (text: string) => text.replace(' └─ [~] VerificationMessageTemplate', ' └─ [~] VerificationMessageTemplate (may cause replacement)')],
  ])('the same pool change is blocked when %s', (_name, edit) => {
    const replaced = edit(STEP2_POOL_DIFF);
    expect(replaced).not.toBe(STEP2_POOL_DIFF);
    expect(evaluateDeployGuard(replaced, [], ['UserAPIServiceStack']).blocked.map((finding) => finding.resource))
      .toEqual(['UserAPIServiceStack/BillboardUserPoolC41FE3DD']);
  });

  // The same run's EmailStack change: the configuration set turns off the account's VDM and Auto Validation for the
  // codes' mail. An in-place update of the set alone; the identity and its records do not move.
  test("EmailStack's recorded diff is one in-place update of the configuration set, and passes the guard", () => {
    const SET_DIFF = fixture('rel54-step2-configuration-set-diff.txt');
    const { stacks, changes } = parseCdkDiff(SET_DIFF);
    expect(stacks).toEqual(['EmailStack']);
    expect(changes).toEqual([
      expect.objectContaining({
        marker: '~',
        type: 'AWS::SES::ConfigurationSet',
        logicalId: 'AccountEmailConfigurationSet31CB700C',
        impact: 'update',
      }),
    ]);
    expect(SET_DIFF).not.toMatch(/replace|replacement|destroy|orphan/);
    const result = evaluateDeployGuard(SET_DIFF, [], ['EmailStack']);
    expect(result.blocked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('deploy guard: allow entries for an intentional replacement', () => {
  const line = '[~] AWS::S3::Bucket BillStoreBucket BillStoreBucket43246214 replace';
  const text = withLineInStack('CongressStoreStack', line);

  test('an entry naming the exact resource lets it through, and the run says so', () => {
    const { exitCode, output } = run(text, ['--allow', 'CongressStoreStack/BillStoreBucket43246214']);
    expect(exitCode).toBe(0);
    expect(output).toContain('WARNING: Allowed by allow_replacements: CongressStoreStack/BillStoreBucket43246214');
  });

  test('entries can come from DEPLOY_GUARD_ALLOW, comma or space separated', () => {
    const env = { DEPLOY_GUARD_ALLOW: 'UserAPIServiceStack/Other1234, CongressStoreStack/BillStoreBucket43246214' };
    const { exitCode, output } = run(text, [], env);
    expect(exitCode).toBe(0);
    expect(output).toContain('NOTICE: Allow entry UserAPIServiceStack/Other1234 matched nothing');
  });

  test('an entry for another stack or resource does not', () => {
    expect(run(text, ['--allow', 'UserStoreStack/BillStoreBucket43246214']).exitCode).toBe(1);
    expect(run(text, ['--allow', 'CongressStoreStack/BillStoreBucket']).exitCode).toBe(1);
  });

  test('a malformed entry is rejected instead of ignored', () => {
    expect(() => parseAllowList(['*'])).toThrow(/must be <Stack>\/<LogicalId>/);
    expect(run(text, ['--allow', 'CongressStoreStack/*']).exitCode).toBe(2);
  });
});

describe('deploy guard: input it cannot check', () => {
  test('text without a stack header fails instead of passing', () => {
    expect(() => evaluateDeployGuard('')).toThrow(/not cdk diff output/);
    expect(run('').exitCode).toBe(2);
    expect(run('Error: something went wrong\n[~] AWS::S3::Bucket B B1 replace').exitCode).toBe(2);
  });

  test('a missing --diff or an unreadable file fails', () => {
    expect(runDeployGuard({ argv: [], env: {}, log: () => undefined })).toBe(2);
    expect(
      runDeployGuard({
        argv: ['--diff', 'missing.txt', '--templates', 'cdk.out'],
        env: {},
        readFile: () => {
          throw new Error('ENOENT: no such file');
        },
        log: () => undefined,
      }),
    ).toBe(2);
  });
});

describe('deploy guard: every synthesized stack must have its section in the diff', () => {
  // A cdk diff that stops at a stack (a GetTemplate or lookup-role error; its loop has no per-stack catch)
  // leaves the sections before it. Behind `| tee` without pipefail the file looks like a finished diff,
  // and cdk deploy --all then deploys the stacks that were never checked.
  const poolReplaced = U9_DIFF.replace(
    /^\[~\] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD$/m,
    '[~] AWS::Cognito::UserPool BillboardUserPool BillboardUserPoolC41FE3DD replace',
  );
  const cutBeforeUserApi = poolReplaced.slice(0, poolReplaced.indexOf('\nStack UserAPIServiceStack'));

  test('a diff cut short before a stack fails instead of passing', () => {
    expect(run(poolReplaced).exitCode).toBe(1);
    expect(parseCdkDiff(cutBeforeUserApi).stacks).toEqual(APP_STACKS.slice(0, 4));
    expect(() => evaluateDeployGuard(cutBeforeUserApi, [], APP_STACKS)).toThrow(
      /no "Stack <name>" section for 11 of the 15 synthesized stacks \(UserAPIServiceStack, ShareSiteStack, /,
    );
    const { exitCode, output } = run(cutBeforeUserApi, [], { GITHUB_ACTIONS: 'true' });
    expect(exitCode).toBe(2);
    expect(output).toMatch(/::error title=Deploy guard::The diff has no "Stack <name>" section for 11 of the 15 synthesized stacks/);
    expect(output).not.toContain('Deploy guard passed');
  });

  test('one missing stack is enough; the whole diff passes', () => {
    const withoutLast = U9_DIFF.slice(0, U9_DIFF.indexOf('\nStack SecurityBaselineStack'));
    expect(run(withoutLast).exitCode).toBe(2);
    expect(run(withoutLast).output).toContain('(SecurityBaselineStack)');
    expect(run(U9_DIFF).exitCode).toBe(0);
    expect(evaluateDeployGuard(U9_DIFF, [], APP_STACKS).stacks).toEqual(APP_STACKS);
  });

  test('--templates is required, and an unreadable or unusable assembly fails', () => {
    const quiet = { env: {}, log: () => undefined };
    expect(runDeployGuard({ ...quiet, argv: ['--diff', 'cdk-diff.txt'], readFile: () => U9_DIFF })).toBe(2);
    const withManifest = (manifest: string) =>
      runDeployGuard({
        ...quiet,
        argv: ['--diff', 'cdk-diff.txt', '--templates', 'cdk.out'],
        readFile: (path) => (path.endsWith('manifest.json') ? manifest : U9_DIFF),
      });
    expect(withManifest(assemblyManifest(APP_STACKS))).toBe(0);
    expect(withManifest('not json')).toBe(2);
    expect(withManifest(assemblyManifest([]))).toBe(2);
    expect(withManifest(assemblyManifest(APP_STACKS, { Stage: { type: 'cdk:cloud-assembly' } }))).toBe(2);
  });

  test('the names are the ones cdk diff prints: the stack id, or the display name a stack artifact sets', () => {
    expect(synthesizedStackNames(assemblyManifest(['A', 'B']))).toEqual(['A', 'B']);
    const named = JSON.stringify({
      artifacts: { A: { type: 'aws:cloudformation:stack', displayName: 'Stage/A' }, T: { type: 'cdk:tree' } },
    });
    expect(synthesizedStackNames(named)).toEqual(['Stage/A']);
  });

  test("the real app's cloud assembly names exactly the stacks of the recorded U9 diff", () => {
    expect(synthesizedStackNames(synthesizedAppManifest()).sort()).toEqual([...APP_STACKS].sort());
    expect(parseCdkDiff(U9_DIFF).stacks).toEqual(APP_STACKS);
  });
});
