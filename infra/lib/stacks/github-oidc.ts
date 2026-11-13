import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  GITHUB_OWNER,
  GITHUB_OWNER_ID,
  GITHUB_PUBLIC_REPOSITORY,
  GITHUB_PUBLIC_REPOSITORY_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  LAMBDA_ARTIFACTS_BUCKET_NAME,
} from '../config/deployment-identity';

export const GITHUB_OIDC_PROVIDER_HOST = 'token.actions.githubusercontent.com';

export const GITHUB_SERVICES_RELEASE_ROLE_NAME = 'GitHubServicesReleaseRole';
export const GITHUB_INFRA_DEPLOY_ROLE_NAME = 'GitHubInfraDeployRole';

// Exact OIDC subjects. No wildcards: `ref:refs/heads/main*` also matched any
// branch whose name starts with "main". A list means "any one of" (StringEquals with several values).
// Both repositories were created after 2026-07-15, so GitHub issues them immutable subjects that carry
// the repo owner and repository IDs; a recreated repo with the same name cannot match. The repo owner
// and the repositories come from deployment-identity.ts.
//
// The private repository (until the close-out of the public switch, CON-13): its main branch, in the
// default subject format `repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main`. It has no environments
// to bind (a private repository on GitHub Free; P0-06, UA-09).
export const GITHUB_PLATFORM_MAIN_SUBJECT =
  `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPOSITORY}@${GITHUB_REPOSITORY_ID}:ref:refs/heads/main`;
// The public repository: its deploy.yml on main, in its production environment, which waits for the
// project's maintainers to approve. The repository's subject template (`include_claim_keys`: repository_owner_id,
// repository_id, context, job_workflow_ref; set through the actions/oidc/customization/sub API) puts all
// three in the subject; a probe on 2026-11-12 showed the format. Any change to that template makes the
// tokens stop matching, so it fails closed.
export const GITHUB_PUBLIC_PRODUCTION_SUBJECT =
  `repository_owner_id:${GITHUB_OWNER_ID}:repository_id:${GITHUB_PUBLIC_REPOSITORY_ID}:environment:production:` +
  `job_workflow_ref:${GITHUB_OWNER}/${GITHUB_PUBLIC_REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`;
export const GITHUB_SERVICES_RELEASE_SUBJECTS: readonly string[] = [
  GITHUB_PLATFORM_MAIN_SUBJECT,
  GITHUB_PUBLIC_PRODUCTION_SUBJECT,
];
export const GITHUB_INFRA_DEPLOY_SUBJECTS: readonly string[] = [
  GITHUB_PLATFORM_MAIN_SUBJECT,
  GITHUB_PUBLIC_PRODUCTION_SUBJECT,
];

export const DEFAULT_LAMBDA_ARTIFACTS_BUCKET_NAME = LAMBDA_ARTIFACTS_BUCKET_NAME;

/**
 * CodeDeploy applications that `scripts/deployLambdaRelease.ts` starts
 * deployments in. Must list every `LambdaApplication` applicationName under
 * lib/stacks (test/github-oidc.test.ts fails when they drift).
 */
export const RELEASE_CODEDEPLOY_APPLICATION_NAMES: readonly string[] = [
  'AnalyticsService',
  'CongressIntegrationService',
  'CongressStore',
  'NotificationService',
  'PriorityService',
  'SummarizerService',
  'UserApiService',
];

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** @default LAMBDA_ARTIFACTS_BUCKET_NAME (deployment-identity.ts) */
  readonly lambdaArtifactsBucketName?: string;
  /** @default RELEASE_CODEDEPLOY_APPLICATION_NAMES */
  readonly codeDeployApplicationNames?: readonly string[];
}

/**
 * Least-privilege roles for GitHub Actions. Uses the account's existing GitHub
 * OIDC provider; it does not create one.
 */
export class GitHubOidcStack extends cdk.Stack {
  public readonly servicesReleaseRole: iam.Role;
  public readonly infraDeployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps = {}) {
    super(scope, id, props);

    const bucketName = props.lambdaArtifactsBucketName ?? DEFAULT_LAMBDA_ARTIFACTS_BUCKET_NAME;
    const bucketArn = `arn:${this.partition}:s3:::${bucketName}`;
    const applicationNames = props.codeDeployApplicationNames ?? RELEASE_CODEDEPLOY_APPLICATION_NAMES;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      this.formatArn({
        service: 'iam',
        region: '',
        resource: 'oidc-provider',
        resourceName: GITHUB_OIDC_PROVIDER_HOST,
      }),
    );

    const gitHubPrincipal = (subjects: readonly string[]): iam.OpenIdConnectPrincipal =>
      new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${GITHUB_OIDC_PROVIDER_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_PROVIDER_HOST}:sub`]: [...subjects],
        },
      });

    // billboard-platform .github/workflows/deploy.yml, release job (scripts/ci/publish-release.sh):
    // `aws s3 cp` of the zips and the release manifest into the artifacts bucket. Nothing else.
    this.servicesReleaseRole = new iam.Role(this, 'GitHubServicesReleaseRole', {
      roleName: GITHUB_SERVICES_RELEASE_ROLE_NAME,
      description: 'GitHub Actions: billboard-platform main uploads Lambda release artifacts',
      assumedBy: gitHubPrincipal(GITHUB_SERVICES_RELEASE_SUBJECTS),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        LambdaArtifactsUpload: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ListArtifactsBucket',
              actions: ['s3:ListBucket'],
              resources: [bucketArn],
            }),
            new iam.PolicyStatement({
              sid: 'ReadWriteArtifacts',
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: [`${bucketArn}/*`],
            }),
          ],
        }),
      },
    });

    // billboard-platform .github/workflows/deploy.yml, deploy job, plus scripts/syncLambdaAliasVersionParameters.ts
    // and scripts/deployLambdaRelease.ts. CloudFormation changes and asset
    // publishing go through the CDK bootstrap roles, never this role directly.
    // A diff run narrows its session with an inline session policy in deploy.yml to the manifest and
    // zip downloads, GetAlias and three bootstrap roles; that policy can only take away from this one.
    this.infraDeployRole = new iam.Role(this, 'GitHubInfraDeployRole', {
      roleName: GITHUB_INFRA_DEPLOY_ROLE_NAME,
      description: 'GitHub Actions: billboard-platform main deploys CDK stacks and Lambda releases',
      assumedBy: gitHubPrincipal(GITHUB_INFRA_DEPLOY_SUBJECTS),
      // The CodeDeploy wait runs up to 150 minutes after synth and cdk deploy.
      maxSessionDuration: cdk.Duration.hours(4),
      inlinePolicies: {
        InfraDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AssumeCdkBootstrapRoles',
              actions: ['sts:AssumeRole'],
              resources: [
                this.formatArn({
                  service: 'iam',
                  region: '',
                  resource: 'role',
                  resourceName: 'cdk-hnb659fds-*',
                }),
              ],
            }),
            new iam.PolicyStatement({
              sid: 'DownloadReleaseManifest',
              actions: ['s3:GetObject'],
              resources: [`${bucketArn}/releases/*`],
            }),
            // In a run given release_id, deploy.yml downloads each zip the manifest names and checks its
            // SHA-256 before synth. A run that builds its release does not need this, so it can deploy it.
            new iam.PolicyStatement({
              sid: 'DownloadReleaseZips',
              actions: ['s3:GetObject'],
              resources: [`${bucketArn}/artifacts/*`],
            }),
            new iam.PolicyStatement({
              sid: 'ReadProdAliases',
              actions: ['lambda:GetAlias'],
              // Function names have no common prefix; GetAlias is read-only.
              resources: [
                this.formatArn({
                  service: 'lambda',
                  resource: 'function',
                  resourceName: '*',
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
            new iam.PolicyStatement({
              sid: 'PinProdAliasVersions',
              actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter'],
              resources: [
                this.formatArn({
                  service: 'ssm',
                  resource: 'parameter',
                  resourceName: 'billboard/prod/lambda-alias-versions/*',
                }),
              ],
            }),
            new iam.PolicyStatement({
              sid: 'RunLambdaDeployments',
              actions: [
                'codedeploy:CreateDeployment',
                'codedeploy:GetDeployment',
                'codedeploy:GetDeploymentGroup',
              ],
              resources: applicationNames.map((name) =>
                this.formatArn({
                  service: 'codedeploy',
                  resource: 'deploymentgroup',
                  resourceName: `${name}/*`,
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ),
            }),
            // CreateDeployment also authorizes the caller to register the
            // revision on the application and to read the group's config.
            new iam.PolicyStatement({
              sid: 'RegisterLambdaRevisions',
              actions: ['codedeploy:GetApplicationRevision', 'codedeploy:RegisterApplicationRevision'],
              resources: applicationNames.map((name) =>
                this.formatArn({
                  service: 'codedeploy',
                  resource: 'application',
                  resourceName: name,
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ),
            }),
            new iam.PolicyStatement({
              sid: 'ReadDeploymentConfigs',
              actions: ['codedeploy:GetDeploymentConfig'],
              // Custom canary configs have CloudFormation-generated names.
              resources: [
                this.formatArn({
                  service: 'codedeploy',
                  resource: 'deploymentconfig',
                  resourceName: '*',
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
            new iam.PolicyStatement({
              sid: 'ReadAlarmsForRollbackReport',
              actions: ['cloudwatch:DescribeAlarms'],
              resources: [
                this.formatArn({
                  service: 'cloudwatch',
                  resource: 'alarm',
                  resourceName: '*',
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
    });

    new cdk.CfnOutput(this, 'GitHubServicesReleaseRoleArn', {
      description: 'role-to-assume for the release job in billboard-platform .github/workflows/deploy.yml',
      value: this.servicesReleaseRole.roleArn,
    });
    new cdk.CfnOutput(this, 'GitHubInfraDeployRoleArn', {
      description: 'role-to-assume for the deploy job in billboard-platform .github/workflows/deploy.yml',
      value: this.infraDeployRole.roleArn,
    });
  }
}
