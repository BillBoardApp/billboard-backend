import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as fs from "node:fs";
import * as path from "node:path";
import { SHARE_SITE_RATE_LIMIT_PER_5_MINUTES } from "../config/abuse-limits";
import { buildManagedRateLimitedWebAclRules } from "./helpers/waf-rules";

const DEFAULT_SHARE_SITE_SOURCE_PATHS = [
  path.resolve(__dirname, "../../../website"), // infra/lib/stacks -> <billboard-platform>/website
];

const resolveShareSiteSourcePath = (scope: Construct): string => {
  const configuredPath = scope.node.tryGetContext("shareSiteSourcePath");
  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    const resolvedPath = path.resolve(configuredPath.trim());
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `Share site source directory not found at ${resolvedPath}. Pass -c shareSiteSourcePath=/absolute/path/to/website with a valid checkout.`,
      );
    }

    return resolvedPath;
  }

  const discoveredPath = DEFAULT_SHARE_SITE_SOURCE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!discoveredPath) {
    throw new Error(
      `Share site source directory not found. Checked ${DEFAULT_SHARE_SITE_SOURCE_PATHS.join(", ")}. Run from a billboard-platform checkout (the site is its website/ directory) or pass -c shareSiteSourcePath=/absolute/path/to/website.`,
    );
  }

  return discoveredPath;
};

const txtRecordGroupKey = (recordName?: string): string => recordName ?? "";

// billboard-website loads only its own app.js, styles.css and /assets images, and
// fetches /public/processed-bill. No inline scripts or styles, no third-party origins.
export const SHARE_SITE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Query parameters read by the fetchProcessedBill handler.
export const SHARE_PUBLIC_API_QUERY_STRINGS = ["guid", "congress", "type", "bill_id"];

// Repository files that must not be published to the site bucket: git metadata (a checkout's
// .git/config can hold its token), GitHub config, docs and local tooling files. Covers both the
// remediation list and the list from the 5008777 hotfix.
export const SHARE_SITE_ASSET_EXCLUDES = [".git", ".git/**", ".git*", ".github", ".github/**", "*.md", ".DS_Store", ".nvmrc"];

// WEB-07 (project decision O3, 2026-11-12): the CloudFront access logs (IP address, time, page, referrer, browser) are
// kept 30 days, as the API and Lambda logs are; it was 90. The privacy policy states this number, so it must be live
// before a policy that says it is published (docs/RUNBOOK.md 25.1). The bucket is not versioned: expiry deletes.
export const SHARE_SITE_ACCESS_LOG_RETENTION_DAYS = 30;

export interface ShareSiteCustomDomainProps {
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
    readonly values: route53.MxRecordValue[];
    readonly ttl?: cdk.Duration;
  }>;
}

export interface ShareSiteStackProps extends cdk.StackProps {
  readonly userApi: apigateway.RestApi;
  readonly sharePublicOriginApiKeyValue: string;
  readonly customDomain?: ShareSiteCustomDomainProps;
}

export class ShareSiteStack extends cdk.Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ShareSiteStackProps) {
    super(scope, id, props);

    const shareSiteSourcePath = resolveShareSiteSourcePath(this);
    const hostedZone = props.customDomain
      ? props.customDomain.hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "ShareSiteHostedZone", {
            hostedZoneId: props.customDomain.hostedZoneId,
            zoneName: props.customDomain.hostedZoneDomainName,
          })
        : route53.HostedZone.fromLookup(this, "ShareSiteHostedZone", {
            domainName: props.customDomain.hostedZoneDomainName,
          })
      : undefined;
    const siteDomainName = props.customDomain?.siteDomainName;
    const shareDomainName = props.customDomain?.shareDomainName;
    const distributionDomainNames = props.customDomain
      ? [siteDomainName, shareDomainName].filter(
          (value, index, values): value is string => typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
        )
      : undefined;
    const certificate = props.customDomain && hostedZone
      ? new certificatemanager.Certificate(this, "ShareSiteCertificate", {
          domainName: shareDomainName!,
          subjectAlternativeNames: distributionDomainNames?.filter((value) => value !== shareDomainName) ?? [],
          validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
        })
      : undefined;

    this.siteBucket = new s3.Bucket(this, "ShareSiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "AbortIncompleteShareSiteUploadsAfter7Days",
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // C1.7: the bucket policy no longer lets the old auto-delete custom resource's role read the bucket
    // tags. Neither that custom resource nor its role exists (checked live 2026-10-07), and the statement
    // was the only one in the app with a wildcard principal. The policy keeps its TLS deny and the
    // CloudFront read grant.

    const accessLogsBucket = new s3.Bucket(this, "ShareSiteAccessLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      lifecycleRules: [
        {
          id: `ExpireAccessLogsAfter${SHARE_SITE_ACCESS_LOG_RETENTION_DAYS}Days`,
          enabled: true,
          expiration: cdk.Duration.days(SHARE_SITE_ACCESS_LOG_RETENTION_DAYS),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const shareSiteWebAcl = new wafv2.CfnWebACL(this, "ShareSiteWebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      // Sampled requests stay on here and on the rules (waf-rules.ts), on purpose, unlike the user API's ACL
      // (user-api-gateway.ts). A sample holds the visitor's IP address and request headers, kept 3 hours by AWS. The
      // privacy policy's "Our website" paragraph already says the hosting service records each visit's IP address,
      // time, page, referrer and browser, kept 30 days. A project decision of 2026-11-12 (WEB-07 privacy draft,
      // checklist item 7) covered only the API and sign-in firewall, whose samples are off.
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "ShareSiteWebAcl",
        sampledRequestsEnabled: true,
      },
      rules: buildManagedRateLimitedWebAclRules({
        metricPrefix: "ShareSite",
        rateLimitRuleName: "ShareSiteRateLimitRule",
        rateLimit: SHARE_SITE_RATE_LIMIT_PER_5_MINUTES,
      }),
    });

    const spaRewriteFunction = new cloudfront.Function(this, "ShareSpaRewriteFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";

  // Keep API requests untouched.
  if (uri.indexOf("/public/") === 0 || uri.indexOf("/api/") === 0) {
    return request;
  }

  // Let direct asset requests through.
  if (uri.indexOf(".") !== -1) {
    return request;
  }

  // Serve the site's pages for their extensionless routes: /privacy, /roadmap, /support (Help) and
  // /about (How Billboard works), with or without a trailing slash.
  var pages = { "/privacy": 1, "/roadmap": 1, "/support": 1, "/about": 1 };
  var page = uri.length > 1 && uri.charAt(uri.length - 1) === "/" ? uri.slice(0, -1) : uri;
  if (pages[page] === 1) {
    request.uri = page + ".html";
    return request;
  }

  // Route known bill-share links and extensionless paths to SPA entrypoint.
  if (uri === "/" || uri.indexOf("/b/") === 0 || uri.indexOf("/share/") === 0) {
    request.uri = "/index.html";
    return request;
  }

  request.uri = "/index.html";
  return request;
}
      `),
    });

    const shareSiteResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "ShareSiteResponseHeadersPolicy", {
      comment: "Billboard share site security headers with a same-origin CSP",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: SHARE_SITE_CONTENT_SECURITY_POLICY,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: false,
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, "ShareSiteDistribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: shareSiteWebAcl.attrArn,
      certificate,
      domainNames: distributionDomainNames,
      logBucket: accessLogsBucket,
      logFilePrefix: "cloudfront/",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: shareSiteResponseHeadersPolicy,
        compress: true,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewriteFunction,
          },
        ],
      },
      additionalBehaviors: {
        "public/*": {
          origin: new origins.RestApiOrigin(props.userApi, {
            originPath: `/${props.userApi.deploymentStage.stageName}`,
            customHeaders: {
              "x-api-key": props.sharePublicOriginApiKeyValue,
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: new cloudfront.CachePolicy(this, "SharePublicApiCachePolicy", {
            minTtl: cdk.Duration.seconds(0),
            defaultTtl: cdk.Duration.seconds(60),
            maxTtl: cdk.Duration.minutes(5),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList(...SHARE_PUBLIC_API_QUERY_STRINGS),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            enableAcceptEncodingBrotli: true,
            enableAcceptEncodingGzip: true,
          }),
          // Forward the same allow list as the cache key, so no parameter can change the
          // response without also changing the cache key.
          originRequestPolicy: new cloudfront.OriginRequestPolicy(this, "SharePublicApiOriginRequestPolicy", {
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.allowList(...SHARE_PUBLIC_API_QUERY_STRINGS),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.none(),
          }),
          responseHeadersPolicy: shareSiteResponseHeadersPolicy,
          compress: true,
        },
      },
    });

    if (hostedZone && props.customDomain) {
      for (const [index, domainName] of distributionDomainNames!.entries()) {
        const recordName = domainName.endsWith(`.${hostedZone.zoneName}`)
          ? domainName.slice(0, -(hostedZone.zoneName.length + 1))
          : domainName;
        const normalizedRecordName = recordName.length > 0 ? recordName : undefined;
        const recordSuffix = index === 0 ? "" : `${index + 1}`;

        new route53.ARecord(this, `ShareSiteAliasRecord${recordSuffix}`, {
          zone: hostedZone,
          recordName: normalizedRecordName,
          target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution)),
        });

        new route53.AaaaRecord(this, `ShareSiteAliasRecordIpv6${recordSuffix}`, {
          zone: hostedZone,
          recordName: normalizedRecordName,
          target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution)),
        });
      }

      const txtRecordGroups = new Map<string, { recordName?: string; values: string[]; ttl?: cdk.Duration }>();
      for (const txtRecord of props.customDomain.txtRecords ?? []) {
        const key = txtRecordGroupKey(txtRecord.recordName);
        const existing = txtRecordGroups.get(key);
        if (existing) {
          existing.values.push(...txtRecord.values);
          existing.ttl = existing.ttl ?? txtRecord.ttl;
        } else {
          txtRecordGroups.set(key, {
            recordName: txtRecord.recordName,
            values: [...txtRecord.values],
            ttl: txtRecord.ttl,
          });
        }
      }

      for (const [index, txtRecord] of Array.from(txtRecordGroups.values()).entries()) {
        new route53.TxtRecord(this, `ShareSiteTxtRecord${index + 1}`, {
          zone: hostedZone,
          recordName: txtRecord.recordName,
          values: txtRecord.values,
          ttl: txtRecord.ttl,
        });
      }

      for (const [index, cnameRecord] of (props.customDomain.cnameRecords ?? []).entries()) {
        new route53.CnameRecord(this, `ShareSiteCnameRecord${index + 1}`, {
          zone: hostedZone,
          recordName: cnameRecord.recordName,
          domainName: cnameRecord.domainName,
          ttl: cnameRecord.ttl,
        });
      }

      for (const [index, mxRecord] of (props.customDomain.mxRecords ?? []).entries()) {
        new route53.MxRecord(this, `ShareSiteMxRecord${index + 1}`, {
          zone: hostedZone,
          recordName: mxRecord.recordName,
          values: mxRecord.values,
          ttl: mxRecord.ttl,
        });
      }
    }

    const shareSiteBaseUrl = props.customDomain
      ? `https://${siteDomainName ?? props.customDomain.shareDomainName}`
      : `https://${this.distribution.distributionDomainName}`;
    const shareBillBaseUrl = props.customDomain
      ? `https://${props.customDomain.shareDomainName}`
      : `https://${this.distribution.distributionDomainName}`;

    // BucketDeployment grants its own role cloudfront:CreateInvalidation on "*" whenever
    // `distribution` is set. Give it this role through withoutPolicyUpdates(), which drops
    // every grant the construct would add, and grant the same access here with the
    // invalidation scoped to this distribution.
    const deploymentRole = new iam.Role(this, "ShareSiteDeploymentRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    const siteAsset = new s3assets.Asset(this, "ShareSiteAsset", {
      path: shareSiteSourcePath,
      exclude: SHARE_SITE_ASSET_EXCLUDES,
    });
    siteAsset.grantRead(deploymentRole);
    this.siteBucket.grantReadWrite(deploymentRole);
    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        resources: [this.distribution.distributionArn],
      })
    );

    new s3deploy.BucketDeployment(this, "ShareSiteDeployment", {
      sources: [s3deploy.Source.bucket(siteAsset.bucket, siteAsset.s3ObjectKey)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      role: deploymentRole.withoutPolicyUpdates(),
    });

    new cdk.CfnOutput(this, "ShareSiteUrl", {
      value: shareSiteBaseUrl,
      description: props.customDomain ? "Share site base URL (custom domain)" : "Share site base URL (CloudFront domain)",
    });

    new cdk.CfnOutput(this, "ShareBillPathTemplate", {
      value: `${shareBillBaseUrl}/b/{guid}`,
      description: props.customDomain
        ? "Template for sharing bill links on the configured custom domain"
        : "Template for sharing bill links before custom domain setup",
    });
  }
}
