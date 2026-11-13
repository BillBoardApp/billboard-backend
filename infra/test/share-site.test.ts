import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as fs from "node:fs";
import * as path from "node:path";
import { SHARE_SITE_RATE_LIMIT_PER_5_MINUTES } from "../lib/config/abuse-limits";
import { BILL_PRIORITY_TABLE_PARTITION_KEY } from "../lib/config/priority-service-constants";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { UserAPIServiceStack } from "../lib/stacks/user-api-service";
import {
  SHARE_PUBLIC_API_QUERY_STRINGS,
  SHARE_SITE_ACCESS_LOG_RETENTION_DAYS,
  SHARE_SITE_CONTENT_SECURITY_POLICY,
  ShareSiteStack,
} from "../lib/stacks/share-site";

// Managed-SecurityHeadersPolicy, which the share site no longer uses.
const MANAGED_SECURITY_HEADERS_POLICY_ID = "67f7725c-6f97-4210-82d7-5512b31e9d03";

const synthShareSite = (): { app: cdk.App; template: Template } => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, "SharedInfraStack");
  const deps = new cdk.Stack(app, "ShareSiteDeps");
  const billPriorityTable = new ddb.Table(deps, "BillPriorityTable", {
    partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  });
  const userApi = new UserAPIServiceStack(app, "UserAPIServiceStack", {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    billPriorityTable,
  });
  const shareSite = new ShareSiteStack(app, "ShareSiteStack", {
    userApi: userApi.userApi,
    sharePublicOriginApiKeyValue: userApi.sharePublicOriginApiKeyValue,
  });
  return { app, template: Template.fromStack(shareSite) };
};

describe("ShareSiteStack", () => {
  test("creates CloudFront distribution, deployment bucket, and URL outputs", () => {
    const app = new cdk.App();
    const shared = new SharedInfraStack(app, "SharedInfraStack");
    const deps = new cdk.Stack(app, "ShareSiteDeps");
    const billPriorityTable = new ddb.Table(deps, "BillPriorityTable", {
      partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });
    const userApi = new UserAPIServiceStack(app, "UserAPIServiceStack", {
      lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
      billPriorityTable,
    });
    const shareSite = new ShareSiteStack(app, "ShareSiteStack", {
      userApi: userApi.userApi,
      sharePublicOriginApiKeyValue: userApi.sharePublicOriginApiKeyValue,
    });

    const template = Template.fromStack(shareSite);

    template.hasResourceProperties("AWS::CloudFront::Distribution", {});
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "AbortIncompleteShareSiteUploadsAfter7Days",
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 7,
            },
          }),
        ]),
      },
    });
    template.hasOutput("ShareSiteUrl", {});
    template.hasOutput("ShareBillPathTemplate", {});
  });

  test("configures a custom domain and Route 53 alias records when provided", () => {
    const app = new cdk.App();
    const shared = new SharedInfraStack(app, "SharedInfraStack");
    const deps = new cdk.Stack(app, "ShareSiteDeps");
    const billPriorityTable = new ddb.Table(deps, "BillPriorityTable", {
      partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });
    const userApi = new UserAPIServiceStack(app, "UserAPIServiceStack", {
      lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
      billPriorityTable,
    });
    const shareSite = new ShareSiteStack(app, "ShareSiteStack", {
      userApi: userApi.userApi,
      sharePublicOriginApiKeyValue: userApi.sharePublicOriginApiKeyValue,
      customDomain: {
        shareDomainName: "share.example.com",
        siteDomainName: "example.com",
        hostedZoneDomainName: "example.com",
        hostedZoneId: "Z123456789",
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
                hostName: "example-com.mail.protection.outlook.com",
                priority: 0,
              },
            ],
            ttl: cdk.Duration.hours(1),
          },
        ],
      },
    });

    const template = Template.fromStack(shareSite);

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: ["example.com", "share.example.com"],
      },
    });
    template.resourceCountIs("AWS::Route53::RecordSet", 7);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: "Z123456789",
      Name: "example.com.",
      ResourceRecords: [
        "\"apple-domain-verification=cJDvqnB3YjUcLioN\"",
        "\"MS=ms56918469\"",
        "\"v=spf1 include:spf.protection.outlook.com -all\"",
      ],
      TTL: "3600",
      Type: "TXT",
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: "Z123456789",
      Name: "autodiscover.example.com.",
      ResourceRecords: ["autodiscover.outlook.com"],
      TTL: "3600",
      Type: "CNAME",
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: "Z123456789",
      Name: "example.com.",
      ResourceRecords: ["0 example-com.mail.protection.outlook.com"],
      TTL: "3600",
      Type: "MX",
    });
    template.hasOutput("ShareSiteUrl", {
      Value: "https://example.com",
    });
    template.hasOutput("ShareBillPathTemplate", {
      Value: "https://share.example.com/b/{guid}",
    });
  });

  describe("security and caching", () => {
    let app: cdk.App;
    let template: Template;
    beforeAll(() => {
      ({ app, template } = synthShareSite());
    });

    // C1.7: the statement for the old auto-delete custom resource's role is gone (neither exists live).
    // What remains: the TLS deny and the CloudFront distribution's read, each naming its principal.
    test("the site bucket policy keeps no legacy statement and no wildcard Allow", () => {
      const siteBucketId = Object.keys(template.findResources("AWS::S3::Bucket")).find((id) => id.startsWith("ShareSiteBucket"));
      expect(siteBucketId).toBeDefined();
      const statements = Object.values(template.findResources("AWS::S3::BucketPolicy"))
        .filter((policy) => JSON.stringify(policy.Properties.Bucket) === JSON.stringify({ Ref: siteBucketId }))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.map((statement) => statement.Sid)).not.toContain("AllowLegacyAutoDeleteCustomResourceBucketTagRead");
      expect(JSON.stringify(statements)).not.toContain("s3:GetBucketTagging");
      expect(JSON.stringify(statements)).not.toContain("CustomS3AutoDeleteObjects");
      // A "*" principal is left only on the TLS deny.
      const wildcardAllows = statements.filter(
        (statement) => statement.Effect === "Allow" && JSON.stringify(statement.Principal) === JSON.stringify({ AWS: "*" }),
      );
      expect(wildcardAllows).toEqual([]);
      expect(statements.filter((statement) => statement.Effect === "Allow").map((statement) => statement.Principal)).toEqual([
        { Service: "cloudfront.amazonaws.com" },
      ]);
    });

    // WEB-07 (project decision O3): the privacy policy says the site's request logs are kept 30 days, so the distribution
    // logs to this one bucket, which expires every log after 30 days and keeps no other rule or version.
    test("keeps the CloudFront access logs 30 days, the period the privacy policy states", () => {
      expect(SHARE_SITE_ACCESS_LOG_RETENTION_DAYS).toBe(30);
      const logBuckets = Object.entries(template.findResources("AWS::S3::Bucket")).filter(([id]) =>
        id.startsWith("ShareSiteAccessLogsBucket"),
      );
      expect(logBuckets).toHaveLength(1);
      const [[logBucketId, logBucket]] = logBuckets;
      expect(logBucket.Properties.LifecycleConfiguration).toEqual({
        Rules: [{ Id: "ExpireAccessLogsAfter30Days", Status: "Enabled", ExpirationInDays: 30 }],
      });
      expect(logBucket.Properties.VersioningConfiguration).toBeUndefined();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Logging: { Bucket: { "Fn::GetAtt": [logBucketId, "RegionalDomainName"] }, Prefix: "cloudfront/" },
        }),
      });
    });

    test("serves a same-origin CSP alongside the standard security headers", () => {
      expect(SHARE_SITE_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
      ["script-src", "style-src", "img-src", "connect-src"].forEach((directive) => {
        expect(SHARE_SITE_CONTENT_SECURITY_POLICY).toContain(`${directive} 'self'`);
      });
      expect(SHARE_SITE_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|unsafe-inline|unsafe-eval|\*/);

      template.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: {
            ContentSecurityPolicy: {
              ContentSecurityPolicy: SHARE_SITE_CONTENT_SECURITY_POLICY,
              Override: true,
            },
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: "DENY", Override: true },
            ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
            StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000, Override: true }),
          },
        }),
      });

      const policyId = Object.keys(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0];
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: { Ref: policyId } }),
          CacheBehaviors: [Match.objectLike({ PathPattern: "public/*", ResponseHeadersPolicyId: { Ref: policyId } })],
        }),
      });
      expect(JSON.stringify(template.toJSON())).not.toContain(MANAGED_SECURITY_HEADERS_POLICY_ID);
    });

    test("keys and forwards the public API only on the query strings fetchProcessedBill reads", () => {
      expect(SHARE_PUBLIC_API_QUERY_STRINGS).toEqual(["guid", "congress", "type", "bill_id"]);
      const allowList = {
        QueryStringBehavior: "whitelist",
        QueryStrings: SHARE_PUBLIC_API_QUERY_STRINGS,
      };
      template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
        CachePolicyConfig: Match.objectLike({
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({ QueryStringsConfig: allowList }),
        }),
      });
      template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
        OriginRequestPolicyConfig: Match.objectLike({ QueryStringsConfig: allowList }),
      });
    });

    test("invalidates every path after a deployment", () => {
      template.hasResourceProperties("Custom::CDKBucketDeployment", {
        DistributionPaths: ["/*"],
        Prune: true,
      });
    });

    test("the deployment handler reads the asset, writes the site bucket and invalidates only this distribution", () => {
      const deploymentRoleId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
        id.startsWith("ShareSiteDeploymentRole"),
      );
      expect(deploymentRoleId).toBeDefined();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Layers: [{ Ref: Match.stringLikeRegexp("^ShareSiteDeploymentAwsCliLayer") }],
        Role: { "Fn::GetAtt": [deploymentRoleId, "Arn"] },
      });

      const policies = Object.values(
        template.findResources("AWS::IAM::Policy", { Properties: { Roles: [{ Ref: deploymentRoleId }] } }),
      );
      expect(policies).toHaveLength(1);
      const statements = policies[0].Properties.PolicyDocument.Statement as {
        Action: string | string[];
        Resource: unknown;
      }[];
      const resourcesFor = (action: string): string =>
        JSON.stringify(statements.filter((statement) => ([] as string[]).concat(statement.Action).includes(action)).map((statement) => statement.Resource));

      const distributionId = Object.keys(template.findResources("AWS::CloudFront::Distribution"))[0];
      const siteBucketId = Object.keys(template.findResources("AWS::S3::Bucket")).find((id) => id.startsWith("ShareSiteBucket"));
      expect(resourcesFor("s3:GetObject*")).toContain("-assets-");
      expect(resourcesFor("s3:PutObject")).toContain(JSON.stringify({ "Fn::GetAtt": [siteBucketId, "Arn"] }));
      expect(resourcesFor("s3:DeleteObject*")).toContain(JSON.stringify({ "Fn::GetAtt": [siteBucketId, "Arn"] }));
      for (const action of ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]) {
        expect(resourcesFor(action)).toContain(":distribution/");
        expect(resourcesFor(action)).toContain(JSON.stringify({ Ref: distributionId }));
        expect(resourcesFor(action)).not.toContain('"*"');
      }
    });

    test("publishes only site files, not repository files", () => {
      const deployments = template.findResources("Custom::CDKBucketDeployment");
      const [objectKey] = Object.values(deployments)[0].Properties.SourceObjectKeys as string[];
      const stagedDir = path.join(app.outdir, `asset.${objectKey.replace(/\.zip$/, "")}`);
      const staged = fs.readdirSync(stagedDir);

      expect(staged).toEqual(
        expect.arrayContaining([
          "index.html",
          "privacy.html",
          "roadmap.html",
          "support.html",
          "about.html",
          "app.js",
          "styles.css",
          "robots.txt",
          "favicon.ico",
          "apple-touch-icon.png",
        ]),
      );
      [".git", ".github", ".gitignore", "README.md", "CONTRIBUTING.md"].forEach((repoFile) => {
        expect(staged).not.toContain(repoFile);
      });
    });

    test("routes extensionless page paths to their pages and leaves files alone", () => {
      const functions = template.findResources("AWS::CloudFront::Function");
      const code = Object.values(functions)[0].Properties.FunctionCode as string;
      const handler = new Function(`${code}\nreturn handler;`)() as (event: unknown) => { uri: string };
      const rewrite = (uri: string): string => handler({ request: { uri } }).uri;

      expect(rewrite("/roadmap")).toBe("/roadmap.html");
      expect(rewrite("/roadmap/")).toBe("/roadmap.html");
      expect(rewrite("/roadmap.html")).toBe("/roadmap.html");
      expect(rewrite("/privacy")).toBe("/privacy.html");
      expect(rewrite("/privacy/")).toBe("/privacy.html");
      expect(rewrite("/support")).toBe("/support.html");
      expect(rewrite("/support/")).toBe("/support.html");
      expect(rewrite("/support.html")).toBe("/support.html");
      expect(rewrite("/about")).toBe("/about.html");
      expect(rewrite("/about/")).toBe("/about.html");
      expect(rewrite("/b/some-guid")).toBe("/index.html");
      expect(rewrite("/share/some-guid")).toBe("/index.html");
      expect(rewrite("/")).toBe("/index.html");
      expect(rewrite("/supportx")).toBe("/index.html");
      expect(rewrite("/about/team")).toBe("/index.html");
      expect(rewrite("/styles.css")).toBe("/styles.css");
      // The files the site adds at its root are served as they are, with the type of their extension.
      expect(rewrite("/robots.txt")).toBe("/robots.txt");
      expect(rewrite("/favicon.ico")).toBe("/favicon.ico");
      expect(rewrite("/apple-touch-icon.png")).toBe("/apple-touch-icon.png");
      expect(rewrite("/public/processed-bill")).toBe("/public/processed-bill");
    });
  });

  // 7B moved the user API ACL to its own two-rule helper (api-waf-rules.ts); the share site's CloudFront ACL
  // keeps the managed rule groups and the rate rule exactly as before (C2 6.1).
  test("the share site's web ACL is unchanged by 7B", () => {
    const { template } = synthShareSite();
    const acls = Object.entries(template.findResources("AWS::WAFv2::WebACL"));
    expect(acls.map(([logicalId]) => logicalId)).toEqual(["ShareSiteWebAcl"]);
    const managedRule = (priority: number, name: string, group: string, metric: string) => ({
      Name: name,
      OverrideAction: { None: {} },
      Priority: priority,
      Statement: { ManagedRuleGroupStatement: { Name: group, VendorName: "AWS" } },
      VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: metric, SampledRequestsEnabled: true },
    });
    expect(acls[0][1].Properties).toEqual({
      DefaultAction: { Allow: {} },
      Scope: "CLOUDFRONT",
      VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: "ShareSiteWebAcl", SampledRequestsEnabled: true },
      Rules: [
        managedRule(0, "AwsManagedCommonRuleSet", "AWSManagedRulesCommonRuleSet", "ShareSiteCommonRuleSet"),
        managedRule(1, "AwsManagedKnownBadInputsRuleSet", "AWSManagedRulesKnownBadInputsRuleSet", "ShareSiteKnownBadInputsRuleSet"),
        managedRule(2, "AwsManagedAmazonIpReputationList", "AWSManagedRulesAmazonIpReputationList", "ShareSiteIpReputationRuleSet"),
        {
          Action: { Block: {} },
          Name: "ShareSiteRateLimitRule",
          Priority: 3,
          Statement: { RateBasedStatement: { AggregateKeyType: "IP", Limit: SHARE_SITE_RATE_LIMIT_PER_5_MINUTES } },
          VisibilityConfig: { CloudWatchMetricsEnabled: true, MetricName: "ShareSiteRateLimitRule", SampledRequestsEnabled: true },
        },
      ],
    });
  });
});
