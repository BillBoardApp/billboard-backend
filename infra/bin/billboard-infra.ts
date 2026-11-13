#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AnalyticsServiceStack } from "../lib/stacks/analytics-service";
import { CongressIntegrationServiceStack } from "../lib/stacks/congress-integration-service";
import { SummarizerServiceStack } from "../lib/stacks/summarizer-service";
import { UserAPIServiceStack } from "../lib/stacks/user-api-service";
import { CongressStoreStack } from "../lib/stacks/congress-store";
import { AggregateDataStoreStack } from "../lib/stacks/aggregate-data-store";
import { NotificationServiceStack } from "../lib/stacks/notification-service";
import { UserStoreStack } from "../lib/stacks/user-store";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { EmailStack } from "../lib/stacks/email";
import { MonitoringStack } from "../lib/stacks/monitoring";
import { ShareSiteStack } from "../lib/stacks/share-site";
import { PriorityServiceStack } from "../lib/stacks/priority-service";
import { GitHubOidcStack } from "../lib/stacks/github-oidc";
import { applyCostAllocationTags, SecurityBaselineStack } from "../lib/stacks/security-baseline";
import { assertReleaseManifestFullyConsumed, getReleaseManifestMetadata } from "../lib/release/lambda-artifacts";
import {
  DEPLOYMENT_ACCOUNT_ID,
  DEPLOYMENT_REGION,
  HOSTED_ZONE_ID,
  MONITORING_SLACK_CHANNEL_ID,
  MONITORING_SLACK_WORKSPACE_ID,
} from "../lib/config/deployment-identity";

interface ShareSiteCustomDomainContext {
  readonly shareDomainName: string;
  readonly siteDomainName?: string;
  readonly hostedZoneDomainName: string;
  readonly hostedZoneId?: string;
  readonly txtRecords?: ReadonlyArray<{
    readonly recordName?: string;
    readonly values: string[];
    readonly ttl?: cdk.Duration;
  }>;
  readonly cnameRecords?: ReadonlyArray<{
    readonly recordName: string;
    readonly domainName: string;
    readonly ttl?: cdk.Duration;
  }>;
  readonly mxRecords?: ReadonlyArray<{
    readonly recordName?: string;
    readonly values: {
      readonly hostName: string;
      readonly priority: number;
    }[];
    readonly ttl?: cdk.Duration;
  }>;
}

interface LegacyShareSiteCustomDomainContext {
  readonly domainName?: string;
}

const DEFAULT_SHARE_SITE_CUSTOM_DOMAIN: ShareSiteCustomDomainContext = {
  shareDomainName: "share.billboard-project.com",
  siteDomainName: "billboard-project.com",
  hostedZoneDomainName: "billboard-project.com",
  hostedZoneId: HOSTED_ZONE_ID,
  txtRecords: [
    {
      values: ["apple-domain-verification=cJDvqnB3YjUcLioN"],
    },
    {
      values: ["MS=ms56918469"],
    },
    {
      values: ["v=spf1 include:spf.protection.outlook.com -all"],
      ttl: cdk.Duration.hours(1),
    },
  ],
  cnameRecords: [
    {
      recordName: "autodiscover",
      domainName: "autodiscover.outlook.com",
      ttl: cdk.Duration.hours(1),
    },
  ],
  mxRecords: [
    {
      values: [
        {
          hostName: "billboardproject-com02c.mail.protection.outlook.com",
          priority: 0,
        },
      ],
      ttl: cdk.Duration.hours(1),
    },
  ],
};

const readShareSiteCustomDomainContext = (app: cdk.App): ShareSiteCustomDomainContext | undefined => {
  const configuredObject = app.node.tryGetContext("shareSiteCustomDomain") as
    | Partial<ShareSiteCustomDomainContext & LegacyShareSiteCustomDomainContext>
    | undefined;
  const shareDomainName =
    configuredObject?.shareDomainName ??
    configuredObject?.domainName ??
    app.node.tryGetContext("shareSiteShareDomainName") ??
    app.node.tryGetContext("shareSiteDomainName");
  const siteDomainName = configuredObject?.siteDomainName ?? app.node.tryGetContext("shareSiteSiteDomainName");
  const hostedZoneDomainName =
    configuredObject?.hostedZoneDomainName ?? app.node.tryGetContext("shareSiteHostedZoneDomainName");
  const hostedZoneId = configuredObject?.hostedZoneId ?? app.node.tryGetContext("shareSiteHostedZoneId");

  if (!shareDomainName && !siteDomainName && !hostedZoneDomainName && !hostedZoneId) {
    return DEFAULT_SHARE_SITE_CUSTOM_DOMAIN;
  }

  if (!shareDomainName || !hostedZoneDomainName) {
    throw new Error(
      "Custom share-site domain configuration requires both a share domain name and shareSiteHostedZoneDomainName (or the shareSiteCustomDomain object equivalent).",
    );
  }

  return {
    shareDomainName,
    siteDomainName,
    hostedZoneDomainName,
    hostedZoneId,
    txtRecords: configuredObject?.txtRecords ?? DEFAULT_SHARE_SITE_CUSTOM_DOMAIN.txtRecords,
    cnameRecords: configuredObject?.cnameRecords ?? DEFAULT_SHARE_SITE_CUSTOM_DOMAIN.cnameRecords,
    mxRecords: configuredObject?.mxRecords ?? DEFAULT_SHARE_SITE_CUSTOM_DOMAIN.mxRecords,
  };
};

const readOptionalStringContext = (app: cdk.App, key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const readBooleanContext = (app: cdk.App, key: string): boolean => {
  const value = app.node.tryGetContext(key);
  return value === true || value === "true";
};

// Exported so test/security.test.ts can assert on the real app, built exactly as `cdk synth` builds it.
export const app = new cdk.App();
const defaultEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? DEPLOYMENT_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEPLOYMENT_REGION,
};
const shareSiteCustomDomain = readShareSiteCustomDomainContext(app);
const userApiSmokeTestSecretName = readOptionalStringContext(app, "userApiSmokeTestSecretName");
const userApiSmokeTestFixturesSecretName = readOptionalStringContext(app, "userApiSmokeTestFixturesSecretName");
const userApiSmokeTestWriteChecksEnabled = readBooleanContext(app, "userApiSmokeTestWriteChecksEnabled");
// The Slack workspace and channel AWS Chatbot posts alarms to: the context values, or deployment-identity.ts when a
// key is absent. An explicit empty string for either key (-c monitoringSlackChannelId=) turns the Chatbot
// configurations off.
const slackOff = ["monitoringSlackWorkspaceId", "monitoringSlackChannelId"].some((key) => {
  const value = app.node.tryGetContext(key);
  return typeof value === "string" && value.trim().length === 0;
});
const monitoringSlackWorkspaceId = slackOff
  ? undefined
  : (readOptionalStringContext(app, "monitoringSlackWorkspaceId") ?? MONITORING_SLACK_WORKSPACE_ID);
const monitoringSlackChannelId = slackOff
  ? undefined
  : (readOptionalStringContext(app, "monitoringSlackChannelId") ?? MONITORING_SLACK_CHANNEL_ID);
// C1.4: the paging channel. Unset (the shipped state until S4), pages go to monitoringSlackChannelId.
const monitoringSlackPageChannelId = readOptionalStringContext(app, "monitoringSlackPageChannelId");
const releaseMetadata = getReleaseManifestMetadata();
if (releaseMetadata.enabled) {
  // Surface manifest context in synth logs for traceability.
  // eslint-disable-next-line no-console
  console.log(
    `[release-manifest] enabled releaseId=${releaseMetadata.releaseId} artifacts=${releaseMetadata.artifactCount}`,
  );
}

const sharedInfraStack = new SharedInfraStack(app, "SharedInfraStack", {
  env: defaultEnv,
});

// REL-54: the SES identity for billboard-project.com. Created here so that `cdk deploy --all` deploys it before the
// service stacks (lib/stacks/email.ts says why).
const emailStack = new EmailStack(app, "EmailStack", {
  hostedZoneId: HOSTED_ZONE_ID,
  env: defaultEnv,
});

const congressIntegrationServiceStack = new CongressIntegrationServiceStack(
  app,
  "CongressIntegrationServiceStack",
  {
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    env: defaultEnv,
  }
);

const priorityServiceStack = new PriorityServiceStack(
  app,
  "PriorityServiceStack",
  {
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    env: defaultEnv,
  }
);

const userAPIServiceStack = new UserAPIServiceStack(
  app,
  "UserAPIServiceStack",
  {
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    billPriorityTable: priorityServiceStack.billPriorityTable,
    smokeTestSecretName: userApiSmokeTestSecretName,
    smokeTestFixturesSecretName: userApiSmokeTestFixturesSecretName,
    smokeTestWriteChecksEnabled: userApiSmokeTestWriteChecksEnabled,
    env: defaultEnv,
  }
);
// REL-54 step 2: the user pool sends through EmailStack's identity, which it names by its fixed ARN (no export). The
// dependency only orders the deploy, so in a new account the identity exists before the pool names it (RUNBOOK 9,
// step 11); nothing is imported, and EmailStack stays free to change.
userAPIServiceStack.addStackDependency(emailStack, "REL-54 step 2: the user pool sends through the SES identity");

new ShareSiteStack(app, "ShareSiteStack", {
  userApi: userAPIServiceStack.userApi,
  sharePublicOriginApiKeyValue: userAPIServiceStack.sharePublicOriginApiKeyValue,
  customDomain: shareSiteCustomDomain,
  env: defaultEnv,
});

const notificationServiceStack = new NotificationServiceStack(
  app,
  "NotificationServiceStack",
  {
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    notificationTypeQueue: sharedInfraStack.notificationTypeQueue,
    billPriorityTable: priorityServiceStack.billPriorityTable,
    env: defaultEnv,
  }
);

const summarizerServiceStack = new SummarizerServiceStack(
  app,
  "SummarizerServiceStack",
  {
    billDifferQueue: congressIntegrationServiceStack.billDifferQueue,
    congressMemberSummarizerQueue: congressIntegrationServiceStack.congressMemberSummarizerQueue,
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    env: defaultEnv,
  }
);

// The store stacks own the data tables and buckets and take no Lambda functions: each service stack
// grants its own functions access by table and bucket name (CQ-15).
const userStoreStack = new UserStoreStack(app, "UserStoreStack", {
  env: defaultEnv,
});

const analyticsServiceStack = new AnalyticsServiceStack(
  app,
  "AnalyticsServiceStack",
  {
    lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
    congressMemberStatsQueue: sharedInfraStack.congressMemberStatsQueue,
    feedbackTableStreamArn: userStoreStack.feedbackTableStreamArn,
    env: defaultEnv,
  }
);

const congressStoreStack = new CongressStoreStack(app, "CongressStoreStack", {
  lambdaArtifactsBucket: sharedInfraStack.lambdaArtifactsBucket,
  notificationTypeQueue: sharedInfraStack.notificationTypeQueue,
  congressMemberStatsQueue: sharedInfraStack.congressMemberStatsQueue,
  env: defaultEnv,
});

const aggregateDataStoreStack = new AggregateDataStoreStack(app, 'AggregateDataStoreStack', {
  env: defaultEnv,
});

new MonitoringStack(app, "MonitoringStack", {
  slackWorkspaceId: monitoringSlackWorkspaceId,
  slackChannelId: monitoringSlackChannelId,
  slackPageChannelId: monitoringSlackPageChannelId,
  env: defaultEnv,
});

// Account-level stacks with no dependencies on the service stacks.
new GitHubOidcStack(app, "GitHubOidcStack", {
  env: defaultEnv,
});

new SecurityBaselineStack(app, "SecurityBaselineStack", {
  env: defaultEnv,
});

// After every stack exists, so each one gets its own `service` tag.
applyCostAllocationTags(app);

assertReleaseManifestFullyConsumed();
