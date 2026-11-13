import { Match } from 'aws-cdk-lib/assertions';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GITHUB_INFRA_DEPLOY_ROLE_NAME,
  GITHUB_SERVICES_RELEASE_ROLE_NAME,
  RELEASE_CODEDEPLOY_APPLICATION_NAMES,
} from '../lib/stacks/github-oidc';
import {
  GITHUB_OWNER,
  GITHUB_OWNER_ID,
  GITHUB_PUBLIC_REPOSITORY,
  GITHUB_PUBLIC_REPOSITORY_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
} from '../lib/config/deployment-identity';
import {
  ACCOUNT,
  BUCKET_ARN,
  INFRA_ROOT,
  PROVIDER_ARN,
  REGION,
  actionsOf,
  asArray,
  roleNamed,
  scriptAwsCalls,
  statementsOf,
  synthOidcStack as synth,
} from './helpers/github-oidc-roles';

// The deploy workflow's use of these roles is tested in deploy-workflow.test.ts.

describe('GitHubOidcStack', () => {
  const template = synth();
  const servicesRole = roleNamed(template, GITHUB_SERVICES_RELEASE_ROLE_NAME);
  const infraRole = roleNamed(template, GITHUB_INFRA_DEPLOY_ROLE_NAME);

  test('references the existing GitHub OIDC provider instead of creating one', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    expect(Object.keys(template.findResources('AWS::Lambda::Function'))).toHaveLength(0);
  });

  // The private repository's main branch, and the public repository's deploy.yml on main in its production
  // environment (the subject template's format), in this order: the export takes this stack unchanged, so the
  // public copy synthesizes exactly the trust that is deployed.
  const trustedSubjects = [
    `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPOSITORY}@${GITHUB_REPOSITORY_ID}:ref:refs/heads/main`,
    `repository_owner_id:${GITHUB_OWNER_ID}:repository_id:${GITHUB_PUBLIC_REPOSITORY_ID}:environment:production:` +
      `job_workflow_ref:${GITHUB_OWNER}/${GITHUB_PUBLIC_REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
  ];

  test.each<[string, string[]]>([
    [GITHUB_SERVICES_RELEASE_ROLE_NAME, trustedSubjects],
    [GITHUB_INFRA_DEPLOY_ROLE_NAME, trustedSubjects],
  ])('%s trusts exactly the listed GitHub subjects', (roleName, subjects) => {
    const role = roleNamed(template, roleName);
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: 'sts:AssumeRoleWithWebIdentity',
        Effect: 'Allow',
        Principal: { Federated: PROVIDER_ARN },
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': subjects,
          },
        },
      },
    ]);
  });

  test('trust policies use no wildcard subject matching', () => {
    for (const role of [servicesRole, infraRole]) {
      const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      expect(trust).not.toContain('StringLike');
      expect(trust).not.toContain('*');
    }
  });

  test('caps session durations at 1 hour (services) and 4 hours (infra)', () => {
    expect(servicesRole.Properties.MaxSessionDuration).toBe(3600);
    expect(infraRole.Properties.MaxSessionDuration).toBe(4 * 3600);
  });

  test('neither role has AdministratorAccess, any managed policy, or wildcard actions/resources', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('AdministratorAccess');
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    template.resourceCountIs('AWS::IAM::Policy', 0);
    for (const role of [servicesRole, infraRole]) {
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
      for (const statement of statementsOf(role)) {
        expect(statement.Effect).toBe('Allow');
        for (const action of asArray(statement.Action)) {
          expect(action).not.toBe('*');
          expect(action).not.toMatch(/:\*$/);
        }
        for (const resource of asArray(statement.Resource)) {
          expect(resource).not.toBe('*');
        }
      }
    }
  });

  test('services release role can only list, read and write the artifacts bucket', () => {
    expect(statementsOf(servicesRole)).toEqual([
      { Sid: 'ListArtifactsBucket', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET_ARN },
      {
        Sid: 'ReadWriteArtifacts',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: `${BUCKET_ARN}/*`,
      },
    ]);
  });

  test('infra deploy role grants exactly the scoped release permissions', () => {
    const bySid = Object.fromEntries(statementsOf(infraRole).map((statement) => [statement.Sid, statement]));
    const codeDeployGroups = RELEASE_CODEDEPLOY_APPLICATION_NAMES.map(
      (name) => `arn:aws:codedeploy:${REGION}:${ACCOUNT}:deploymentgroup:${name}/*`,
    );
    const codeDeployApps = RELEASE_CODEDEPLOY_APPLICATION_NAMES.map(
      (name) => `arn:aws:codedeploy:${REGION}:${ACCOUNT}:application:${name}`,
    );

    expect(bySid).toEqual({
      AssumeCdkBootstrapRoles: {
        Sid: 'AssumeCdkBootstrapRoles',
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-*`,
      },
      DownloadReleaseManifest: {
        Sid: 'DownloadReleaseManifest',
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: `${BUCKET_ARN}/releases/*`,
      },
      ReadProdAliases: {
        Sid: 'ReadProdAliases',
        Effect: 'Allow',
        Action: 'lambda:GetAlias',
        Resource: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:*`,
      },
      PinProdAliasVersions: {
        Sid: 'PinProdAliasVersions',
        Effect: 'Allow',
        Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter'],
        Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/billboard/prod/lambda-alias-versions/*`,
      },
      RunLambdaDeployments: {
        Sid: 'RunLambdaDeployments',
        Effect: 'Allow',
        Action: ['codedeploy:CreateDeployment', 'codedeploy:GetDeployment', 'codedeploy:GetDeploymentGroup'],
        Resource: codeDeployGroups,
      },
      RegisterLambdaRevisions: {
        Sid: 'RegisterLambdaRevisions',
        Effect: 'Allow',
        Action: ['codedeploy:GetApplicationRevision', 'codedeploy:RegisterApplicationRevision'],
        Resource: codeDeployApps,
      },
      ReadDeploymentConfigs: {
        Sid: 'ReadDeploymentConfigs',
        Effect: 'Allow',
        Action: 'codedeploy:GetDeploymentConfig',
        Resource: `arn:aws:codedeploy:${REGION}:${ACCOUNT}:deploymentconfig:*`,
      },
      ReadAlarmsForRollbackReport: {
        Sid: 'ReadAlarmsForRollbackReport',
        Effect: 'Allow',
        Action: 'cloudwatch:DescribeAlarms',
        Resource: `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:*`,
      },
    });
  });

  test('infra deploy role cannot write to S3, IAM or CloudFormation directly', () => {
    const actions = actionsOf(infraRole);
    for (const action of actions) {
      expect(action).not.toMatch(/^(iam|cloudformation):/);
      expect(action).not.toBe('s3:PutObject');
    }
  });

  test('infra deploy role covers every AWS call made by the release scripts', () => {
    const granted = actionsOf(infraRole);
    const needed = scriptAwsCalls();
    expect(needed).toEqual(expect.arrayContaining(['lambda:GetAlias', 'ssm:PutParameter', 'codedeploy:CreateDeployment']));
    expect(needed.filter((action) => !granted.has(action))).toEqual([]);
  });

  test('CodeDeploy application list matches every LambdaApplication in lib/stacks', () => {
    const stacksDir = join(INFRA_ROOT, 'lib', 'stacks');
    const declared = new Set<string>();
    for (const file of readdirSync(stacksDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(stacksDir, file), 'utf8');
      for (const match of source.matchAll(/new codedeploy\.LambdaApplication\([^)]*?applicationName:\s*['"]([^'"]+)['"]/gs)) {
        declared.add(match[1]);
      }
    }
    expect([...declared].sort()).toEqual([...RELEASE_CODEDEPLOY_APPLICATION_NAMES].sort());
  });

  test('outputs both role ARNs', () => {
    template.hasOutput('GitHubServicesReleaseRoleArn', {
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^GitHubServicesReleaseRole'), 'Arn'] },
    });
    template.hasOutput('GitHubInfraDeployRoleArn', {
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^GitHubInfraDeployRole'), 'Arn'] },
    });
  });
});
