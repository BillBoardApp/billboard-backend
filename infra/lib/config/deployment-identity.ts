// Deployment identity: the identifiers that tie this app to one production deployment, namely its AWS account, its
// public DNS zone, the Slack channel its alarms go to, the GitHub repository allowed to deploy it, and the globally
// unique names of its fixed S3 buckets. They live here, and only here, so that a copy of this repository can deploy
// somewhere else by replacing this file: bin/billboard-infra.ts, the stacks and every test read them from this module.
//
// Identifiers that are already public through the app, the website or DNS (the domain, the App Store and Apple team
// IDs, the domain's verification records) are not deployment secrets and stay where they are used.

/** The AWS account and region the stacks deploy to when the CDK CLI does not name them (CDK_DEFAULT_ACCOUNT and
 * CDK_DEFAULT_REGION). The published code carries AWS's documentation example account here instead of the real one,
 * which the deploy workflow passes as CDK_DEFAULT_ACCOUNT from the production environment's AWS_ACCOUNT_ID secret. */
export const DEPLOYMENT_ACCOUNT_ID = '111122223333';
export const DEPLOYMENT_REGION = 'us-east-1';

/** The Route 53 public hosted zone of the project's domain. ShareSiteStack and EmailStack add their records to it;
 * neither creates nor owns it. */
export const HOSTED_ZONE_ID = 'Z042484932F0V8RTY6BAX';

/** The Slack workspace and channel AWS Chatbot posts alarms to (MonitoringStack). The `monitoringSlackWorkspaceId`
 * and `monitoringSlackChannelId` context values override them. */
export const MONITORING_SLACK_WORKSPACE_ID = 'T0B2XM1EEFR';
export const MONITORING_SLACK_CHANNEL_ID = 'C0B39P514SZ';

/** The GitHub repositories that may assume the deploy roles (GitHubOidcStack). GitHub issues repositories created
 * after 2026-07-15 immutable OIDC subjects that carry the repo owner and repository IDs as well as their names.
 * GITHUB_REPOSITORY is the private repository the project deployed from until the public switch (CON-13): its main
 * branch keeps its trust until the close-out removes it. GITHUB_PUBLIC_REPOSITORY is the public repository that
 * deploys from then on, through its production environment. */
export const GITHUB_OWNER = 'BillBoardApp';
export const GITHUB_OWNER_ID = '237660567';
export const GITHUB_REPOSITORY = 'billboard-platform';
export const GITHUB_REPOSITORY_ID = '1409003646';
export const GITHUB_PUBLIC_REPOSITORY = 'billboard-backend';
export const GITHUB_PUBLIC_REPOSITORY_ID = '1455989902';

/** Fixed S3 bucket names. They are global across AWS, so another deployment needs its own. */
export const LAMBDA_ARTIFACTS_BUCKET_NAME = 'billboard-lambda-artifacts';
export const BILL_STORE_BUCKET_NAME = 'billboard-bill-store-bucket';
export const CONGRESS_MEMBER_STORE_BUCKET_NAME = 'billboard-congress-member-store-bucket';
