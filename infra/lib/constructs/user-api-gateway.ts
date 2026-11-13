import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import {
  COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME,
  USER_API_NAME,
} from '../config/user-api-service-constants';
import {
  COGNITO_SIGN_UP_RATE_LIMIT,
  COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS,
  SHARE_PUBLIC_USAGE_PLAN_THROTTLE,
  USER_API_STAGE_THROTTLE,
} from '../config/abuse-limits';
import { alarmTopicFromName } from '../stacks/helpers/alarm-topic';
import { buildApiRateLimitRules, type SignUpRateLimitAction } from '../stacks/helpers/api-waf-rules';

/** Responses of at least this many bytes are gzip-compressed for clients that send Accept-Encoding: gzip. */
const API_MIN_COMPRESSION_BYTES = 1024;

export interface UserApiGatewayProps {
  /** Pool whose tokens the Cognito authorizer accepts. The web ACL is also associated with it (7B). */
  readonly userPool: cognito.IUserPool;
  /** The web ACL's CognitoSignUpRateLimit action (SIGNUP_RATE_LIMIT_ACTION). */
  readonly signUpRateLimitAction: SignUpRateLimitAction;
}

/** Name of the alarm on the web ACL's sign-up rule (routine tier, the alarm topic). */
export const COGNITO_SIGN_UP_RATE_LIMITED_ALARM_NAME = 'Billboard-Waf-CognitoSignUpRateLimited';

/**
 * The user API's REST API and the wiring around it: `prod` stage with access logs and throttling
 * (and no X-Ray tracing), the account-level CloudWatch role, a regional WAF web ACL (on the stage and,
 * since 7B, on the user pool), the JSON body validator and the Cognito authorizer. Routes stay in
 * UserAPIServiceStack, which adds them with addCognitoMethod and addPublicMethod;
 * contracts/scripts/check-contracts.mjs reads them from there.
 *
 * Every resource is created in the parent scope, not under this construct, so each keeps the
 * logical ID it had when this code lived in UserAPIServiceStack. Nesting them would change the
 * IDs and make CloudFormation replace the API, its stage and the WAF association.
 */
export class UserApiGateway extends Construct {
  public readonly api: apigateway.RestApi;
  private readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  private readonly jsonBodyMethodOptions: Pick<
    apigateway.MethodOptions,
    'requestModels' | 'requestValidator'
  >;

  constructor(scope: Construct, id: string, props: UserApiGatewayProps) {
    super(scope, id);
    const stack = cdk.Stack.of(scope);

    const apiAccessLogs = new logs.LogGroup(scope, 'UserApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const apiGatewayLogsRole = new iam.Role(scope, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });
    const apiGatewayAccount = new apigateway.CfnAccount(scope, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayLogsRole.roleArn,
    });

    this.api = new apigateway.RestApi(scope, 'UserApi', {
      restApiName: USER_API_NAME,
      // Gzip any response of 1 KB or more for clients that accept it: the windowed bills manifest is about 1 MB of
      // JSON and compresses about 5x (app slowness report, 2026-10-14).
      minCompressionSize: cdk.Size.bytes(API_MIN_COMPRESSION_BYTES),
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: false,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        // No X-Ray tracing on the stage (WEB-07 privacy draft, gap G12; project decision of 2026-11-12): each stage
        // segment recorded the caller's IP address, user agent, URL and X-Forwarded-For, kept 30 days, which the
        // privacy policy's "We do not store the IP address itself" rules out. The Lambda functions keep their own
        // active tracing, whose segments hold no client IP. Set to false, not left out, so CloudFormation turns it
        // off on the live stage. Do not turn it back on unless the privacy policy discloses it (docs/RUNBOOK.md 25.1).
        tracingEnabled: false,
        throttlingBurstLimit: USER_API_STAGE_THROTTLE.burstLimit,
        throttlingRateLimit: USER_API_STAGE_THROTTLE.rateLimit,
      },
    });
    this.api.deploymentStage.node.addDependency(apiGatewayAccount);
    // API Gateway applies the compression setting to a stage only with a new deployment; this makes the setting part
    // of the deployment's identity, so changing it creates one.
    this.api.latestDeployment?.addToLogicalId({ minCompressionSize: API_MIN_COMPRESSION_BYTES });

    // 7B: the same resource, updated in place to the two rate rules of buildApiRateLimitRules (the managed
    // rule groups are gone). The share site's ACL keeps its own rules.
    const userApiWebAcl = new wafv2.CfnWebACL(scope, 'UserApiWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      // No sampled requests, here or on the rules (api-waf-rules.ts): WEB-07 privacy draft, checklist item 7, project
      // decision of 2026-11-12. Each sample held the caller's IP address and every request header, kept 3 hours by
      // AWS, which the privacy policy's "We do not store the IP address itself" rules out. The metrics stay on under
      // the same names, so the alarm below and the rate rules are unchanged; CloudFormation updates the ACL in place.
      // Do not turn samples back on unless the privacy policy says so first (docs/RUNBOOK.md 25.1).
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'UserApiWebAcl',
        sampledRequestsEnabled: false,
      },
      rules: buildApiRateLimitRules({ signUpRateLimitAction: props.signUpRateLimitAction }),
    });

    const userApiStageArn = `arn:aws:apigateway:${stack.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`;
    new wafv2.CfnWebACLAssociation(scope, 'UserApiWebAclAssociation', {
      resourceArn: userApiStageArn,
      webAclArn: userApiWebAcl.attrArn,
    });
    // 7B: the user pool's unauthenticated API calls (SignUp, InitiateAuth, ResendConfirmationCode,
    // ForgotPassword, ...) pass through the same ACL. A pool takes one ACL; the association references the
    // pool, never the reverse, so it adds no dependency to the pool or its trigger.
    new wafv2.CfnWebACLAssociation(scope, 'UserPoolWebAclAssociation', {
      resourceArn: props.userPool.userPoolArn,
      webAclArn: userApiWebAcl.attrArn,
    });

    // The sign-up rule's requests, counted or blocked (WAF emits CountedRequests in count mode and
    // BlockedRequests in block mode), summed over an hour. The ACL's name is generated, so the WebACL
    // dimension is taken from its Ref ("name|id|scope"). The alarm topic is MonitoringStack's routine tier.
    const webAclName = cdk.Fn.select(0, cdk.Fn.split('|', userApiWebAcl.ref));
    const signUpRuleMetric = (metricName: 'CountedRequests' | 'BlockedRequests'): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName,
        dimensionsMap: { WebACL: webAclName, Rule: COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME, Region: stack.region },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      });
    const signUpRateLimitedAlarm = new cloudwatch.Alarm(scope, 'CognitoSignUpRateLimitedAlarm', {
      alarmName: COGNITO_SIGN_UP_RATE_LIMITED_ALARM_NAME,
      alarmDescription: `The ${COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME} rule of the user API web ACL matched in the last hour: one IP sent more than ${COGNITO_SIGN_UP_RATE_LIMIT} SignUp, ResendConfirmationCode or ForgotPassword calls in ${COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS / 60} minutes. With SIGNUP_RATE_LIMIT_ACTION=count nothing was refused (CountedRequests); with block those calls got a 403 ForbiddenException (BlockedRequests). The web ACL keeps no sampled requests (privacy, WEB-07): CloudTrail records each counted call with its source IP, and RUNBOOK 14.6 counts the calls over the limit by hour without printing an IP. Flip count to block only if the counted requests came from the test sign-ups (RUNBOOK section 14).`,
      metric: new cloudwatch.MathExpression({
        expression: 'SUM([counted, blocked])',
        usingMetrics: {
          counted: signUpRuleMetric('CountedRequests'),
          blocked: signUpRuleMetric('BlockedRequests'),
        },
        label: `${COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME} counted plus blocked requests per hour`,
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    signUpRateLimitedAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopicFromName(scope)));

    const genericJsonBodyModel = this.api.addModel('GenericJsonBodyModel', {
      contentType: 'application/json',
      modelName: 'BillboardGenericJsonBody',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'BillboardGenericJsonBody',
        type: apigateway.JsonSchemaType.OBJECT,
      },
    });
    const bodyRequestValidator = new apigateway.RequestValidator(scope, 'BodyRequestValidator', {
      restApi: this.api,
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    this.cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      scope,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [props.userPool],
      }
    );
    this.jsonBodyMethodOptions = {
      requestModels: {
        'application/json': genericJsonBodyModel,
      },
      requestValidator: bodyRequestValidator,
    };
  }

  /** A Cognito-authorized method. `requiresJsonBody` adds the JSON object body model and validator. */
  public addCognitoMethod(
    resource: apigateway.IResource,
    httpMethod: string,
    handler: lambda.IFunction,
    requiresJsonBody = false,
  ): apigateway.Method {
    return resource.addMethod(
      httpMethod,
      new apigateway.LambdaIntegration(handler),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: this.cognitoAuthorizer,
        ...(requiresJsonBody ? this.jsonBodyMethodOptions : {}),
      },
    );
  }

  /** A method with no authorizer; pass `apiKeyRequired` to put it behind a usage-plan key. */
  public addPublicMethod(
    resource: apigateway.IResource,
    httpMethod: string,
    handler: lambda.IFunction,
    methodOptions: apigateway.MethodOptions = {},
  ): apigateway.Method {
    return resource.addMethod(
      httpMethod,
      new apigateway.LambdaIntegration(handler),
      {
        authorizationType: apigateway.AuthorizationType.NONE,
        ...methodOptions,
      },
    );
  }

  /**
   * The usage plan and API key the share site's CloudFront origin sends on the public
   * processed-bill route, throttled on `method` to SHARE_PUBLIC_USAGE_PLAN_THROTTLE.
   */
  public addSharePublicUsagePlan(method: apigateway.Method, apiKeyValue: string): void {
    const sharePublicUsagePlan = this.api.addUsagePlan('SharePublicUsagePlan', {
      name: 'BillboardSharePublicUsagePlan',
      throttle: {
        rateLimit: SHARE_PUBLIC_USAGE_PLAN_THROTTLE.rateLimit,
        burstLimit: SHARE_PUBLIC_USAGE_PLAN_THROTTLE.burstLimit,
      },
    });
    const sharePublicApiKey = this.api.addApiKey('SharePublicApiKey', {
      apiKeyName: 'BillboardSharePublicApiKey',
      value: apiKeyValue,
      description: 'Private key used by CloudFront when requesting the public share endpoint.',
    });
    sharePublicUsagePlan.addApiKey(sharePublicApiKey);
    sharePublicUsagePlan.addApiStage({
      stage: this.api.deploymentStage,
      throttle: [
        {
          method,
          throttle: {
            rateLimit: SHARE_PUBLIC_USAGE_PLAN_THROTTLE.rateLimit,
            burstLimit: SHARE_PUBLIC_USAGE_PLAN_THROTTLE.burstLimit,
          },
        },
      ],
    });
  }
}
