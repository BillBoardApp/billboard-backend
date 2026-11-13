import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import {
  COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME,
  COGNITO_SIGN_UP_RATE_LIMITED_OPERATIONS,
} from '../../config/user-api-service-constants';
import {
  COGNITO_SIGN_UP_RATE_LIMIT,
  COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS,
  USER_API_RATE_LIMIT_PER_5_MINUTES,
} from '../../config/abuse-limits';

/** What the sign-up rule does with an IP over its limit (SIGNUP_RATE_LIMIT_ACTION). */
export type SignUpRateLimitAction = 'count' | 'block';

export interface ApiRateLimitRuleProps {
  /** SIGNUP_RATE_LIMIT_ACTION: 'count' or 'block' (C2 7 step 5). */
  readonly signUpRateLimitAction: SignUpRateLimitAction;
}

/** The API rule's name, which is also its metric name (and the `Rule` dimension of its WAF metrics). */
export const USER_API_RATE_LIMIT_RULE_NAME = 'UserApiRateLimitRule';

/** The AWS JSON target header of each rate-limited Cognito operation, e.g. `AWSCognitoIdentityProviderService.SignUp`. */
export const cognitoTargetHeaderValue = (operation: string): string => `AWSCognitoIdentityProviderService.${operation}`;

// FieldToMatch.singleHeader is untyped JSON in the L1 construct, so CDK passes its keys through unchanged
// and CloudFormation expects `Name`. WAF matches header names in lower case.
const headerEquals = (headerName: string, value: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { singleHeader: { Name: headerName } },
    positionalConstraint: 'EXACTLY',
    searchString: value,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

// No sampled requests (WEB-07 privacy draft, checklist item 7; project decision of 2026-11-12): a sample holds the
// caller's IP address and every request header, which AWS keeps 3 hours, and the privacy policy says "We do not store
// the IP address itself" apart from the audit log. The rules still act and still send their CloudWatch metrics under
// the same names (the sign-up rule's alarm reads them); UserApiGateway turns the ACL's own samples off too. Do not turn
// them back on unless the privacy policy says so first (docs/RUNBOOK.md 25.1).
const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: false,
});

/**
 * 7B (SEC-02, CAP-10): the user API web ACL's two rate rules. The share site's ACL builds its own rules
 * through buildManagedRateLimitedWebAclRules, which this file leaves untouched. The limits are in
 * abuse-limits.ts.
 *
 * The same ACL is associated with the API stage and the user pool, so both rules see API Gateway and
 * Cognito user-pool calls alike:
 *
 * 0. UserApiRateLimitRule: every request per IP, blocked above USER_API_RATE_LIMIT_PER_5_MINUTES in WAF's
 *    default 5-minute window. No scope-down, so no header can dodge it. Unchanged apart from its priority
 *    (3 before).
 * 1. CognitoSignUpRateLimit: SignUp, ResendConfirmationCode and ForgotPassword calls per IP, above
 *    COGNITO_SIGN_UP_RATE_LIMIT in COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS. Each sends an email from Cognito's
 *    own mailer, whose daily quota the whole account shares. The action follows `signUpRateLimitAction`. An
 *    operation is recognised by the AWS JSON target header Cognito's SDK clients send, or by the
 *    operation-name header Cognito adds for requests it serves itself; both are compared exactly, lower-case
 *    header names as WAF requires.
 */
export const buildApiRateLimitRules = ({
  signUpRateLimitAction,
}: ApiRateLimitRuleProps): wafv2.CfnWebACL.RuleProperty[] => [
  {
    name: USER_API_RATE_LIMIT_RULE_NAME,
    priority: 0,
    statement: {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        limit: USER_API_RATE_LIMIT_PER_5_MINUTES,
      },
    },
    action: { block: {} },
    visibilityConfig: visibility(USER_API_RATE_LIMIT_RULE_NAME),
  },
  {
    name: COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME,
    priority: 1,
    statement: {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        limit: COGNITO_SIGN_UP_RATE_LIMIT,
        evaluationWindowSec: COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS,
        scopeDownStatement: {
          orStatement: {
            statements: [
              ...COGNITO_SIGN_UP_RATE_LIMITED_OPERATIONS.map((operation) =>
                headerEquals('x-amz-target', cognitoTargetHeaderValue(operation))),
              ...COGNITO_SIGN_UP_RATE_LIMITED_OPERATIONS.map((operation) =>
                headerEquals('x-amzn-cognito-operation-name', operation)),
            ],
          },
        },
      },
    },
    action: signUpRateLimitAction === 'block' ? { block: {} } : { count: {} },
    visibilityConfig: visibility(COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME),
  },
];
