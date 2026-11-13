import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

interface ManagedRateLimitedWebAclRuleProps {
  readonly metricPrefix: string;
  readonly rateLimit: number;
  readonly rateLimitRuleName: string;
}

/**
 * The share site's ACL rules: three AWS managed rule groups and a per-IP rate rule, each with sampled requests on
 * (share-site.ts says why the website keeps them). The user API's ACL keeps none (api-waf-rules.ts, WEB-07), so do
 * not reuse these rules there without turning their samples off.
 */
export const buildManagedRateLimitedWebAclRules = ({
  metricPrefix,
  rateLimit,
  rateLimitRuleName,
}: ManagedRateLimitedWebAclRuleProps): wafv2.CfnWebACL.RuleProperty[] => [
  {
    name: 'AwsManagedCommonRuleSet',
    priority: 0,
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesCommonRuleSet',
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: `${metricPrefix}CommonRuleSet`,
      sampledRequestsEnabled: true,
    },
  },
  {
    name: 'AwsManagedKnownBadInputsRuleSet',
    priority: 1,
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesKnownBadInputsRuleSet',
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: `${metricPrefix}KnownBadInputsRuleSet`,
      sampledRequestsEnabled: true,
    },
  },
  {
    name: 'AwsManagedAmazonIpReputationList',
    priority: 2,
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesAmazonIpReputationList',
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: `${metricPrefix}IpReputationRuleSet`,
      sampledRequestsEnabled: true,
    },
  },
  {
    name: rateLimitRuleName,
    priority: 3,
    statement: {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        limit: rateLimit,
      },
    },
    action: { block: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: rateLimitRuleName,
      sampledRequestsEnabled: true,
    },
  },
];
