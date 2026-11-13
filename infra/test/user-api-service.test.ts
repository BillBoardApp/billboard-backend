import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  APP_ATTEST_ALLOWED_ENVIRONMENTS,
  APP_ATTEST_ATTEST_THROTTLE,
  APP_ATTEST_CHALLENGE_THROTTLE,
  APP_ATTEST_CHALLENGE_TTL_SECONDS,
  APP_ATTEST_CLIENT_MODE,
  APP_ATTEST_EXEMPT_GROUP,
  APP_ATTEST_FAIL_CLOSED,
  APP_ATTEST_MAX_ACCOUNTS_PER_KEY,
  APP_ATTEST_RESERVED_CONCURRENCY,
  APP_ATTEST_SIGN_UP_MODE,
  APP_ATTEST_VOTE_MODE,
  DEVICE_CHECK_MODE,
  DEVICE_COUNTER_WINDOW_MONTHS,
  DEVICE_MAX_ACCOUNTS,
  MIN_APP_VERSION,
  SIGNUP_FILTER_CHECK_ADDRESS,
  SIGNUP_FILTER_CHECK_ENABLED,
  SIGNUP_FILTER_MODE,
  UNCONFIRMED_SIGNUP_CLEANUP_MODE,
  UNCONFIRMED_SIGNUP_MAX_AGE_HOURS,
  UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN,
  USER_API_STAGE_THROTTLE,
  VERIFICATION_LIMITS_MODE,
  VOTE_DAILY_CAP_MODE,
} from "../lib/config/abuse-limits";
import {
  COMPANION_GROUPS_ENABLED,
  PRE_SIGN_UP_CHECK_INTENTIONAL_ERROR_METRICS,
  RETIRED_PROFILE_ATTRIBUTES_MODE,
  SIGNUP_FILTER_CHECK_RESERVED_CONCURRENCY,
} from "../lib/config/user-api-service-constants";
import { USER_API_CANARY_SCRIPT_PATH } from "../lib/constructs/user-api-canary";
import { COGNITO_SIGN_UP_RATE_LIMITED_ALARM_NAME, UserApiGateway } from "../lib/constructs/user-api-gateway";
import {
  isDataWrite,
  leadingKeysCondition,
  partitionScopedGrants,
  roleStatementsOf,
  storeActions,
} from "./helpers/cdk-test-helpers";
import { synthesizeStacks } from "./helpers/synth-stacks";
import { BILL_STORE_BUCKET_NAME } from "../lib/config/deployment-identity";

const templates = synthesizeStacks();

describe("UserAPIServiceStack", () => {
  test("creates the user pool and user API lambdas", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "BillboardUserPool",
    });

    [
      "RegisterUserDevice",
      "DeviceNotificationSettings",
      "DeletePreferences",
      "FetchPreferences",
      "SetPreferences",
      "FetchProcessedBill",
      "SetFeedback",
      "FetchBillStats",
      "FetchProcessedCongressMembers",
      "FetchCongressMemberCivicProfile",
      "DistrictVerification",
      "AdultAttestation",
      "FetchMe",
      "FetchLatestWeeklyDigest",
      "GenerateWeeklyDigests",
      "AccountData",
      "AccountDataStatus",
      "SignUpFilterCheck",
    ].forEach((functionName) => {
      templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
      });
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "RegisterUserDevice",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          APNS_PLATFORM_APPLICATION_ARN: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
          PARTITION_KEY: Match.anyValue(),
          SORT_KEY: Match.anyValue(),
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchProcessedCongressMembers",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          BUCKET_NAME: Match.anyValue(),
          STATS_TABLE_NAME: "CongressMembersStats",
          STATS_PRIMARY_KEY: "bioguideId",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchCongressMembersManifest",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          STATS_TABLE_NAME: "CongressMembersStats",
          STATS_PRIMARY_KEY: "bioguideId",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchCongressMemberCivicProfile",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TABLE_NAME: "CongressMemberVoteProfiles",
          PARTITION_KEY: "bioguideId",
          LEGISLATIVE_TABLE_NAME: "CongressMemberLegislativeProfiles",
          LEGISLATIVE_PARTITION_KEY: "bioguideId",
        }),
      }),
    });

    // Legacy feedback rows without a civic profile snapshot are resolved through the
    // manifest's BILL_GUID lookup rows; without MANIFEST_TABLE_NAME that lookup is skipped.
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchCivicProfile",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TABLE_NAME: "UserFeedback",
          PARTITION_KEY: "userId",
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_SORT_KEY: "sk",
          MANIFEST_GUID_LOOKUP_PK: "BILL_GUID",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchLatestWeeklyDigest",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TABLE_NAME: "UserWeeklyDigests",
          PARTITION_KEY: "userId",
          SORT_KEY: "publishedAt",
          CANONICAL_SCHEDULE_EXPRESSION: "cron(0 10 ? * SUN *)",
          CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
          CANONICAL_PUBLISH_DAY: "SUNDAY",
          CANONICAL_PUBLISH_HOUR: "10",
          CANONICAL_PUBLISH_MINUTE: "0",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "GenerateWeeklyDigests",
      Timeout: 900,
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TABLE_NAME: "UserWeeklyDigests",
          PARTITION_KEY: "userId",
          SORT_KEY: "publishedAt",
          PII_TABLE_NAME: "UserPII",
          PII_PARTITION_KEY: "userId",
          PREFERENCES_TABLE_NAME: "UserPreferences",
          PREFERENCES_PARTITION_KEY: "userId",
          PREFERENCES_SORT_KEY: "preference",
          FEEDBACK_TABLE_NAME: "UserFeedback",
          FEEDBACK_PARTITION_KEY: "userId",
          FEEDBACK_SORT_KEY: "billId",
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_PK_VALUE: "BILL",
          MANIFEST_SORT_KEY: "sk",
          CONGRESS_MEMBERS_TABLE_NAME: "CongressMembersManifest",
          CONGRESS_MEMBERS_PRIMARY_KEY: "bioguideId",
          BUCKET_NAME: BILL_STORE_BUCKET_NAME,
          CANONICAL_SCHEDULE_EXPRESSION: "cron(0 10 ? * SUN *)",
          CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
          CANONICAL_PUBLISH_DAY: "SUNDAY",
          CANONICAL_PUBLISH_HOUR: "10",
          CANONICAL_PUBLISH_MINUTE: "0",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "AccountData",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          WEEKLY_DIGESTS_TABLE_NAME: "UserWeeklyDigests",
          WEEKLY_DIGESTS_PARTITION_KEY: "userId",
          WEEKLY_DIGESTS_SORT_KEY: "publishedAt",
        }),
      }),
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CleanupOrphanedUsers",
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          WEEKLY_DIGESTS_TABLE_NAME: "UserWeeklyDigests",
          WEEKLY_DIGESTS_PARTITION_KEY: "userId",
          WEEKLY_DIGESTS_SORT_KEY: "publishedAt",
        }),
      }),
    });

    // API Gateway: RestApi, resources and methods
    templates.userApiTemplate.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Name: "BillboardUserApi",
      // Gzip for responses of 1 KB or more (the windowed bills manifest is about 1 MB of JSON).
      MinimumCompressionSize: 1024,
    });

    [
      "register-device",
      "device-notification-settings",
      "preferences",
      "me",
      "weekly-digests",
      "latest",
      "adult-attestation",
      "account-data",
      "status",
      "public",
      "processed-bill",
      "feedback",
      "bill-stats",
      "congress-member-civic-profile",
      "processed-congress-members",
      "district-verification",
    ].forEach((pathPart) => {
      templates.userApiTemplate.hasResourceProperties("AWS::ApiGateway::Resource", {
        PathPart: pathPart,
      });
    });

    ["GET", "POST", "PUT", "DELETE"].forEach((method) => {
      templates.userApiTemplate.hasResourceProperties("AWS::ApiGateway::Method", {
        HttpMethod: method,
        AuthorizationType: "COGNITO_USER_POOLS",
      });
    });

    templates.userApiTemplate.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      AuthorizationType: "NONE",
    });

    templates.userApiTemplate.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 10 ? * SUN *)",
      ScheduleExpressionTimezone: "America/New_York",
      FlexibleTimeWindow: {
        Mode: "OFF",
      },
      State: "ENABLED",
      Target: Match.objectLike({
        Arn: Match.anyValue(),
        RoleArn: Match.anyValue(),
      }),
    });
  });

  test("sizes memory per function and gives FetchProcessedBill a 10 s timeout", () => {
    const explicitMemory: Record<string, number> = {
      FetchBillsManifest: 1024,
      PublishBillsManifest: 1024,
      GenerateWeeklyDigests: 1024,
      WeeklyDigestWorker: 1024,
      FetchCongressMembersManifest: 512,
      CleanupOrphanedUsers: 512,
      ExportCognitoUsers: 512,
      AccountData: 512,
      FetchBillStats: 512,
      FetchCivicScore: 512,
      FetchCivicProfile: 512,
      FetchCongressMemberCivicProfile: 512,
    };
    Object.entries(explicitMemory).forEach(([functionName, memorySize]) => {
      templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
        MemorySize: memorySize,
      });
    });

    // Everything else inherits the 256 MB release-backed default.
    ["FetchProcessedBill", "FetchMe", "RegisterUserDevice", "FetchProcessedCongressMembers"].forEach(
      (functionName) => {
        templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: functionName,
          MemorySize: 256,
        });
      },
    );

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchProcessedBill",
      Timeout: 10,
    });
  });

  // Infra review item 15b: no API handler runs at Lambda's 3-second default, which turned a rare slow
  // request (cold start, SDK retry) into a 502. The two manifest handlers already had 30 seconds
  // (API Gateway itself stops waiting at 29); every other handler is at 10. PreSignUpCheck is no API
  // handler: Cognito waits at most 5 seconds for a trigger (X4).
  test("gives every API handler an explicit timeout of 10 to 30 seconds", () => {
    const WORKERS = [
      "GenerateWeeklyDigests",
      "WeeklyDigestWorker",
      "CleanupOrphanedUsers",
      "ExportCognitoUsers",
      "PublishBillsManifest",
      "RestampUserVotes",
      "SignUpFilterCheck",
    ];
    const COGNITO_TRIGGERS = ["PreSignUpCheck"];
    const formerlyDefaulted = [
      "RegisterUserDevice",
      "DeviceNotificationSettings",
      "DeletePreferences",
      "FetchPreferences",
      "SetPreferences",
      "FetchFeedback",
      "SetFeedback",
      "FetchProcessedCongressMembers",
    ];
    const functions = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function"))
      .map((resource) => resource.Properties)
      .filter((properties) => typeof properties.FunctionName === "string");
    const apiHandlers = functions.filter((properties) =>
      !WORKERS.includes(properties.FunctionName) && !COGNITO_TRIGGERS.includes(properties.FunctionName));

    expect(apiHandlers).toHaveLength(22);
    apiHandlers.forEach(({ FunctionName, Timeout }) => {
      expect({ FunctionName, Timeout }).toEqual({ FunctionName, Timeout: expect.any(Number) });
      expect(Timeout).toBeGreaterThanOrEqual(10);
      expect(Timeout).toBeLessThanOrEqual(30);
    });
    formerlyDefaulted.forEach((functionName) => {
      templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
        Timeout: 10,
      });
    });
    // No function in the stack, worker or custom-resource provider included, is left at the default.
    Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function")).forEach((resource) =>
      expect(resource.Properties.Timeout).toEqual(expect.any(Number)),
    );
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "PreSignUpCheck",
      Timeout: 5,
    });
  });

  // CON-08: API handlers use CodeDeploy's built-in 10% / 10-minute canary; the custom config is gone.
  test("deploys scheduled workers all at once and API handlers on the 10-minute canary", () => {
    const groups = templates.userApiTemplate.findResources("AWS::CodeDeploy::DeploymentGroup");
    const configFor = (prefix: string): unknown => {
      const entry = Object.entries(groups).find(([logicalId]) =>
        logicalId.startsWith(`${prefix}DeploymentGroup`),
      );
      expect(entry).toBeDefined();
      return entry![1].Properties.DeploymentConfigName;
    };

    expect(configFor("GenerateWeeklyDigests")).toBe("CodeDeployDefault.LambdaAllAtOnce");
    expect(configFor("WeeklyDigestWorker")).toBe("CodeDeployDefault.LambdaAllAtOnce");
    expect(configFor("PublishBillsManifest")).toBe("CodeDeployDefault.LambdaAllAtOnce");
    expect(configFor("CleanupOrphanedUsers")).toBe("CodeDeployDefault.LambdaAllAtOnce");
    expect(configFor("ExportCognitoUsers")).toBe("CodeDeployDefault.LambdaAllAtOnce");
    ["FetchBillsManifest", "FetchProcessedBill", "FetchMe", "AccountData"].forEach((prefix) => {
      expect(configFor(prefix)).toBe("CodeDeployDefault.LambdaCanary10Percent10Minutes");
    });
    templates.userApiTemplate.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
  });

  test("hardens the Cognito user pool and app client", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "BillboardUserPool",
      MfaConfiguration: "OPTIONAL",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      DeletionProtection: "ACTIVE",
    });

    templates.userApiTemplate.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
    templates.userApiTemplate.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "BillboardUserPoolClient",
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      AllowedOAuthFlowsUserPoolClient: false,
      AllowedOAuthFlows: Match.absent(),
      CallbackURLs: Match.absent(),
      GenerateSecret: Match.absent(),
    });
  });

  test("gives the Synthetics canary its own USER_PASSWORD_AUTH client", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "BillboardCanaryClient",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      AllowedOAuthFlowsUserPoolClient: false,
      AllowedOAuthFlows: Match.absent(),
    });

    const clients = templates.userApiTemplate.findResources("AWS::Cognito::UserPoolClient");
    const passwordClients = Object.entries(clients).filter(([, client]) =>
      (client.Properties.ExplicitAuthFlows as string[]).includes("ALLOW_USER_PASSWORD_AUTH"),
    );
    expect(passwordClients.map(([, client]) => client.Properties.ClientName)).toEqual([
      "BillboardCanaryClient",
    ]);

    templates.userApiTemplate.hasResourceProperties("AWS::Synthetics::Canary", {
      RunConfig: Match.objectLike({
        EnvironmentVariables: Match.objectLike({
          USER_POOL_CLIENT_ID: { Ref: passwordClients[0][0] },
        }),
      }),
    });
  });

  test("retains the district verification hash salt secret", () => {
    templates.userApiTemplate.hasResource("AWS::SecretsManager::Secret", {
      Properties: Match.objectLike({ Name: "Billboard/DistrictVerificationHashSalt" }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("logs API Gateway execution at ERROR and keeps access logs, with X-Ray tracing off", () => {
    // WEB-07 G12: a traced stage records each caller's IP address for 30 days, which the privacy policy rules out.
    // False, not absent, so CloudFormation turns it off on the live stage.
    templates.userApiTemplate.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "prod",
      TracingEnabled: false,
      AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
      MethodSettings: Match.arrayWith([
        Match.objectLike({ LoggingLevel: "ERROR", MetricsEnabled: true }),
      ]),
    });
  });

  test("deploys lib/canaries/user-api-canary.js as the canary script, and the file parses", () => {
    const source = fs.readFileSync(USER_API_CANARY_SCRIPT_PATH, "utf8");
    // Compiles without running: a syntax error in the script fails here, not in the canary.
    expect(() => new vm.Script(source, { filename: USER_API_CANARY_SCRIPT_PATH })).not.toThrow();

    const canaries = templates.userApiTemplate.findResources("AWS::Synthetics::Canary");
    expect(Object.values(canaries).map((canary) => canary.Properties.Code)).toEqual([
      { Handler: "index.handler", Script: source.trim() },
    ]);
  });

  test("sets 30-day retention on the canary's Lambda log group", () => {
    templates.userApiTemplate.hasResourceProperties("Custom::LogRetention", {
      RetentionInDays: 30,
      LogGroupName: {
        "Fn::Join": ["", ["/aws/lambda/cwsyn-billboard-api-", { "Fn::GetAtt": ["UserApiCanary", "Id"] }]],
      },
    });
  });

  // Every statement in the IAM policies attached to a function's execution role.
  const roleStatements = (functionName: string): Array<Record<string, any>> => {
    const functions = templates.userApiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: functionName },
    });
    const [fn] = Object.values(functions);
    const roleLogicalId = fn.Properties.Role["Fn::GetAtt"][0];
    return Object.values(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  };
  const actionsOf = (statement: Record<string, any>): string[] =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  const userPoolArn = { "Fn::GetAtt": [expect.stringMatching(/^BillboardUserPool/), "Arn"] };

  // UA-15 (FN-4): the salt reaches DistrictVerification only as the secret's ARN. The handler reads it at its first
  // use in a container and has no HASH_SALT variable to fall back on (districtVerification.test.ts).
  test("DistrictVerification gets the hash salt secret ARN and read access, and no plaintext salt", () => {
    const saltSecret = templates.userApiTemplate.findResources("AWS::SecretsManager::Secret", {
      Properties: { Name: "Billboard/DistrictVerificationHashSalt" },
    });
    const [saltSecretId] = Object.keys(saltSecret);
    expect(saltSecretId).toBeDefined();

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "DistrictVerification",
      Environment: {
        Variables: Match.objectLike({ HASH_SALT_SECRET_ARN: { Ref: saltSecretId } }),
      },
    });
    const [districtVerification] = Object.values(
      templates.userApiTemplate.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "DistrictVerification" },
      }),
    );
    const variables = districtVerification.Properties.Environment.Variables;
    expect(Object.keys(variables)).not.toContain("HASH_SALT");
    expect(JSON.stringify(variables)).not.toContain("resolve:secretsmanager");

    const readsSalt = roleStatements("DistrictVerification").some((statement) =>
      actionsOf(statement).includes("secretsmanager:GetSecretValue")
      && JSON.stringify(statement.Resource).includes(saltSecretId));
    expect(readsSalt).toBe(true);
  });

  test("AccountData can delete the Cognito user and the user's SNS endpoints", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "AccountData",
      Timeout: 28,
      Environment: {
        Variables: Match.objectLike({
          USER_POOL_ID: { Ref: Match.stringLikeRegexp("^BillboardUserPool") },
          DEVICES_PUSH_TOKEN_INDEX_NAME: "GSIPushTokenIndex",
        }),
      },
    });

    const statements = roleStatements("AccountData");
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({ Action: "cognito-idp:AdminDeleteUser", Resource: userPoolArn }),
    ]));
    const deleteEndpoint = statements.filter((statement) => actionsOf(statement).includes("sns:DeleteEndpoint"));
    expect(deleteEndpoint).toHaveLength(1);
    expect(JSON.stringify(deleteEndpoint[0].Resource)).toMatch(/:endpoint\/APNS\/BillboardApnsProduction\/\*"/);
    // AdminDeleteUser is the only Cognito write AccountData gets.
    const cognitoActions = statements.flatMap(actionsOf).filter((action) => action.startsWith("cognito-idp:"));
    expect(cognitoActions).toEqual(["cognito-idp:AdminDeleteUser"]);
  });

  test("CleanupOrphanedUsers starts in dry-run with a deletion cap and does not retry aborts", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CleanupOrphanedUsers",
      Environment: {
        Variables: Match.objectLike({
          USER_POOL_ID: { Ref: Match.stringLikeRegexp("^BillboardUserPool") },
          DRY_RUN: "true",
          MAX_DELETIONS_PER_RUN: "50",
        }),
      },
    });

    // REL-53: AdminDeleteUser only with UNCONFIRMED_SIGNUP_CLEANUP_MODE 'delete' (tested below).
    const cognitoActions = roleStatements("CleanupOrphanedUsers")
      .flatMap(actionsOf)
      .filter((action) => action.startsWith("cognito-idp:"))
      .sort();
    expect(cognitoActions).toEqual([
      ...(UNCONFIRMED_SIGNUP_CLEANUP_MODE === "delete" ? ["cognito-idp:AdminDeleteUser"] : []),
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
    ]);

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: Match.stringLikeRegexp("^CleanupOrphanedUsers") },
      MaximumRetryAttempts: 0,
    });
  });

  // C1.10 (D3 step 1): the abort minimum drops to 2, the resume settings and the shared-endpoint index
  // arrive, and DRY_RUN stays "true". No new IAM: the deletes come with step 2.
  test("CleanupOrphanedUsers gets the step-1 safety-net settings, still in dry run and with no new delete permission", () => {
    const [cleanup] = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "CleanupOrphanedUsers" },
    }));
    expect(cleanup.Properties.Environment.Variables).toEqual(expect.objectContaining({
      DRY_RUN: "true",
      ORPHAN_ABORT_MIN_COUNT: "2",
      RESUME_MIN_STALE_HOURS: "24",
      MAX_RESUMES_PER_RUN: "10",
      DEVICES_PUSH_TOKEN_INDEX_NAME: "GSIPushTokenIndex",
      MAX_DELETIONS_PER_RUN: "50",
    }));

    // The account-integrity tables add only reads (X23; tested with App Attest below).
    const actions = roleStatements("CleanupOrphanedUsers").flatMap(actionsOf);
    expect(actions).not.toContain("sns:DeleteEndpoint");
    // Step 1 adds no Cognito delete. REL-53's 'delete' mode does (one statement, for its own step): from then on
    // DRY_RUN alone keeps a resume from deleting the sign-in (docs/RUNBOOK.md 8.1).
    expect(actions.filter((action) => action === "cognito-idp:AdminDeleteUser")).toEqual(
      UNCONFIRMED_SIGNUP_CLEANUP_MODE === "delete" ? ["cognito-idp:AdminDeleteUser"] : [],
    );
    expect(actions.filter((action) => action.startsWith("sns:"))).toEqual([]);
    // The failure destination's grant is its only SQS access.
    expect([...new Set(actions.filter((action) => action.startsWith("sqs:")))].sort()).toEqual([
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:SendMessage",
    ]);
  });

  // C1.1: GenerateWeeklyDigests keeps Lambda's default 2 retries, now written out, and records a run that
  // still fails in ScheduledJobFailures.
  test("GenerateWeeklyDigests may publish only its own metric namespace and keeps async retries", () => {
    expect(roleStatements("GenerateWeeklyDigests")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: "cloudwatch:PutMetricData",
        Resource: "*",
        Condition: { StringEquals: { "cloudwatch:namespace": "BillBoard/WeeklyDigest" } },
      }),
    ]));

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: Match.stringLikeRegexp("^GenerateWeeklyDigests") },
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: Match.absent(),
      DestinationConfig: {
        OnFailure: { Destination: Match.objectLike({ "Fn::Join": ["", Match.arrayWith([":ScheduledJobFailures"])] }) },
      },
    });
  });

  test("ExportCognitoUsers exports the user pool nightly with ListUsers and PutObject, and deletes only retired attributes", () => {
    const [bucketId] = Object.keys(templates.userApiTemplate.findResources("AWS::S3::Bucket"))
      .filter((logicalId) => logicalId.startsWith("CognitoUserExportBucket"));
    expect(bucketId).toBeDefined();

    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "ExportCognitoUsers",
      MemorySize: 512,
      Timeout: 300,
      Environment: {
        Variables: {
          USER_POOL_ID: { Ref: Match.stringLikeRegexp("^BillboardUserPool") },
          EXPORT_BUCKET: { Ref: bucketId },
          RETIRED_PROFILE_ATTRIBUTES_MODE: "clear",
        },
      },
    });

    // UX-36: AdminDeleteUserAttributes comes with RETIRED_PROFILE_ATTRIBUTES_MODE 'clear' only. Nothing else on the
    // pool: no AdminUpdateUserAttributes, no AdminDeleteUser.
    const statements = roleStatements("ExportCognitoUsers");
    const cognitoStatements = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith("cognito-idp:")));
    expect(cognitoStatements.map((statement) => statement.Resource)).toEqual(cognitoStatements.map(() => userPoolArn));
    expect(cognitoStatements.flatMap(actionsOf).sort()).toEqual([
      "cognito-idp:AdminDeleteUserAttributes",
      "cognito-idp:ListUsers",
    ]);
    const s3Statements = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith("s3:")));
    expect(s3Statements).toEqual([
      expect.objectContaining({
        Action: "s3:PutObject",
        Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/cognito-users/*"]] },
      }),
    ]);
    expect(statements.flatMap(actionsOf).filter((action) => /^(kms|dynamodb|sns|secretsmanager):/.test(action))).toEqual([]);

    // Retries are safe because a rerun on the same day overwrites that day's object.
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: Match.stringLikeRegexp("^ExportCognitoUsers") },
      MaximumRetryAttempts: 2,
    });

    const aliasRef = { Ref: Match.stringLikeRegexp("^ExportCognitoUsersProdAlias") };
    templates.userApiTemplate.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 8 * * ? *)",
      State: "ENABLED",
      Targets: [Match.objectLike({ Arn: aliasRef })],
    });
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      FunctionName: aliasRef,
      Principal: "events.amazonaws.com",
      SourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^ExportCognitoUsersSchedule"), "Arn"] },
    });

    templates.userApiTemplate.hasOutput("CognitoUserExportBucketName", { Value: { Ref: bucketId } });
  });

  // UX-36 (WEB-07; project decision O1): the pinned value, and its rollback. 'count' changes only ExportCognitoUsers'
  // switch and takes its AdminDeleteUserAttributes away; the user pool and its app clients are untouched either way, so
  // app 1.1 can still save party, gender and birth year (the nightly run deletes them).
  test("RETIRED_PROFILE_ATTRIBUTES_MODE is 'clear', and 'count' changes only ExportCognitoUsers' switch and grant", () => {
    expect(RETIRED_PROFILE_ATTRIBUTES_MODE).toBe("clear");
    const current = templates.userApiTemplate.toJSON() as CfnTemplate;
    const counting = synthUserApiWithModules({
      "../lib/config/user-api-service-constants": { RETIRED_PROFILE_ATTRIBUTES_MODE: "count" },
    });
    const [fnId] = Object.keys(templates.userApiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "ExportCognitoUsers" },
    }));
    const [policyId] = Object.entries(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
      .filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes("ExportCognitoUsersServiceRole"))
      .map(([id]) => id);
    expect(templateChanges(current, counting)).toEqual({ added: [], removed: [], changed: [fnId, policyId].sort() });
    expect(counting.Resources[fnId].Properties.Environment.Variables.RETIRED_PROFILE_ATTRIBUTES_MODE).toBe("count");
    const countingActions = (counting.Resources[policyId].Properties.PolicyDocument.Statement as Array<Record<string, any>>)
      .flatMap(actionsOf);
    expect(countingActions).toContain("cognito-idp:ListUsers");
    expect(countingActions).not.toContain("cognito-idp:AdminDeleteUserAttributes");

    // The app client keeps Cognito's default: every attribute writable, as app 1.1 needs.
    for (const client of Object.values(templates.userApiTemplate.findResources("AWS::Cognito::UserPoolClient"))) {
      expect(client.Properties.WriteAttributes).toBeUndefined();
    }
  });

  // ── CAP-01: bills manifest snapshot ──────────────────────────────────────

  const logicalIdsOf = (type: string, prefix: string): string[] =>
    Object.keys(templates.userApiTemplate.findResources(type)).filter((logicalId) => logicalId.startsWith(prefix));
  const snapshotBucketId = (): string => {
    const [bucketId, ...others] = logicalIdsOf("AWS::S3::Bucket", "BillsManifestSnapshotBucket");
    expect(others).toEqual([]);
    return bucketId;
  };
  const functionEnvironment = (functionName: string): Record<string, unknown> => {
    const [fn] = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: functionName },
    }));
    return fn.Properties.Environment.Variables;
  };
  // APPF-23: what services/src/adapters/billCompanionDao.ts reads, the same in every function that uses it.
  const companionEnvironment = {
    MANIFEST_TABLE_NAME: "BillsManifest",
    MANIFEST_PRIMARY_KEY: "pk",
    MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
    MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
    GUID_LOOKUP_PK: "BILL_GUID",
  };
  const snapshotObjectArn = () => ({
    "Fn::Join": ["", [{ "Fn::GetAtt": [snapshotBucketId(), "Arn"] }, "/bills/manifest-v1.json"]],
  });
  const s3StatementsOf = (functionName: string) =>
    roleStatements(functionName).filter((statement) => actionsOf(statement).some((action) => action.startsWith("s3:")));

  test("keeps the manifest snapshot in a private, retained, unversioned SSE-S3 bucket with a generated name", () => {
    const bucketId = snapshotBucketId();
    const bucket = templates.userApiTemplate.findResources("AWS::S3::Bucket")[bucketId];
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.UpdateReplacePolicy).toBe("Retain");
    expect(bucket.Properties).toEqual({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      // Nothing else: no BucketName (CDK-generated), no versioning, no CORS, no lifecycle rules.
    });

    // The bucket policy only denies requests without TLS; access comes from the two roles below.
    const policies = Object.values(templates.userApiTemplate.findResources("AWS::S3::BucketPolicy"))
      .filter((policy) => JSON.stringify(policy.Properties.Bucket) === JSON.stringify({ Ref: bucketId }));
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement as Array<Record<string, any>>;
    expect(statements).toEqual([
      expect.objectContaining({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    ]);

    templates.userApiTemplate.hasOutput("BillsManifestSnapshotBucketName", { Value: { Ref: bucketId } });
  });

  test("PublishBillsManifest builds the same manifest as FetchBillsManifest and knows the snapshot location", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "PublishBillsManifest",
      MemorySize: 1024,
      Timeout: 120,
      ReservedConcurrentExecutions: Match.absent(),
    });

    const publisher = functionEnvironment("PublishBillsManifest");
    expect(publisher).toEqual({
      TABLE_NAME: "BillsManifest",
      PRIMARY_KEY: "pk",
      PK_VALUE: "BILL",
      PRIORITY_TABLE_NAME: expect.anything(),
      PRIORITY_TABLE_PARTITION_KEY: "guid",
      PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
      PRIORITY_STATUS_ATTRIBUTE: "status",
      PRIORITY_SORT_KEY_ATTRIBUTE: "prioritySortKey",
      PRIORITY_ACTIVE_STATUS_VALUE: "ACTIVE",
      MANIFEST_SNAPSHOT_BUCKET: { Ref: snapshotBucketId() },
      MANIFEST_SNAPSHOT_KEY: "bills/manifest-v1.json",
      // APPF-23
      MANIFEST_TABLE_NAME: "BillsManifest",
      MANIFEST_PRIMARY_KEY: "pk",
      MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
      MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
      GUID_LOOKUP_PK: "BILL_GUID",
      COMPANION_GROUPS_ENABLED: "true",
    });
    expect(publisher).toEqual(expect.objectContaining(companionEnvironment));
    // Inline answers and the snapshot must be byte-identical, so the source settings match exactly.
    // Only the publisher reads the companion kill switch; FetchBillsManifest follows the groups row.
    const { COMPANION_GROUPS_ENABLED: publisherSwitch, ...publisherSource } = publisher;
    expect(publisherSwitch).toBe("true");
    expect(functionEnvironment("FetchBillsManifest")).toEqual(publisherSource);
  });

  test("PublishBillsManifest may read and write only the snapshot object, and list the bucket", () => {
    expect(s3StatementsOf("PublishBillsManifest")).toEqual([
      { Action: ["s3:GetObject", "s3:PutObject"], Effect: "Allow", Resource: snapshotObjectArn() },
      { Action: "s3:ListBucket", Effect: "Allow", Resource: { "Fn::GetAtt": [snapshotBucketId(), "Arn"] } },
    ]);
    expect(roleStatements("PublishBillsManifest")).toEqual(expect.arrayContaining([
      {
        Action: "cloudwatch:PutMetricData",
        Effect: "Allow",
        Resource: "*",
        Condition: { StringEquals: { "cloudwatch:namespace": "BillBoard/BillsManifest" } },
      },
    ]));
    // BillPriority and BillsManifest are read; the only DynamoDB write is the companion groups row.
    const dynamoResources = JSON.stringify(roleStatements("PublishBillsManifest")
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith("dynamodb:"))));
    expect(dynamoResources).toContain("BillPriorityTable");
    expect(Object.keys(storeActions(roleStatements("PublishBillsManifest")))).toEqual(["table/BillsManifest"]);
    const unscoped = roleStatements("PublishBillsManifest").filter((statement) => statement.Condition === undefined);
    expect(unscoped.flatMap(actionsOf)
      .filter((action) => /^dynamodb:(Put|Update|Delete|BatchWrite)|^(sqs|sns|kms|secretsmanager):/.test(action))).toEqual([]);
    expect(partitionScopedGrants(roleStatements("PublishBillsManifest"))).toEqual([
      { resource: "table/BillsManifest", actions: ["dynamodb:PutItem"], condition: leadingKeysCondition("BILL_COMPANION_GROUPS") },
    ]);
  });

  test("FetchBillsManifest may only read the snapshot object (to presign it) and list the bucket", () => {
    expect(s3StatementsOf("FetchBillsManifest")).toEqual([
      { Action: "s3:GetObject", Effect: "Allow", Resource: snapshotObjectArn() },
      { Action: "s3:ListBucket", Effect: "Allow", Resource: { "Fn::GetAtt": [snapshotBucketId(), "Arn"] } },
    ]);
    // Its metrics are embedded-metric log lines, so it needs no PutMetricData.
    expect(JSON.stringify(roleStatements("FetchBillsManifest"))).not.toContain("cloudwatch:PutMetricData");
  });

  test("only the two manifest functions can reach the snapshot bucket", () => {
    const bucketId = snapshotBucketId();
    const grantees = Object.values(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(bucketId))
      .flatMap((policy) => policy.Properties.Roles.map((role: { Ref: string }) => role.Ref))
      .sort();
    expect(grantees).toEqual([
      expect.stringMatching(/^FetchBillsManifestServiceRole/),
      expect.stringMatching(/^PublishBillsManifestServiceRole/),
    ]);
  });

  test("runs PublishBillsManifest every 10 minutes through the prod alias with short retries", () => {
    const aliasRef = { Ref: Match.stringLikeRegexp("^PublishBillsManifestProdAlias") };
    templates.userApiTemplate.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(10 minutes)",
      ScheduleExpressionTimezone: Match.absent(),
      FlexibleTimeWindow: { Mode: "OFF" },
      State: "ENABLED",
      Target: {
        Arn: aliasRef,
        RoleArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^PublishBillsManifestSchedulerRole"), "Arn"] },
        RetryPolicy: { MaximumEventAgeInSeconds: 540, MaximumRetryAttempts: 2 },
      },
    });

    const [roleId] = logicalIdsOf("AWS::IAM::Role", "PublishBillsManifestSchedulerRole");
    templates.userApiTemplate.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: "scheduler.amazonaws.com" } })],
      }),
    });
    const schedulerStatements = Object.values(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.Roles) === JSON.stringify([{ Ref: roleId }]))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    // C1.1: Scheduler writes the schedule's dead letters to ScheduledJobFailures with this role.
    expect(schedulerStatements).toEqual([
      { Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { Ref: expect.stringMatching(/^PublishBillsManifestProdAlias/) } },
      {
        Action: "sqs:SendMessage",
        Effect: "Allow",
        Resource: { "Fn::Join": ["", expect.arrayContaining([":ScheduledJobFailures"])] },
      },
    ]);
    // Scheduler invokes asynchronously; the function itself gets no Lambda retries (the next run replaces it).
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: Match.stringLikeRegexp("^PublishBillsManifest") },
      MaximumRetryAttempts: 0,
    });
  });

  // The app relies on the snapshot pointer (Cache-Control: no-store) never being cached, and sends
  // the new `delivery` query parameter.
  test("GET /bills-manifest is not cached by API Gateway and validates no query parameters", () => {
    Object.values(templates.userApiTemplate.findResources("AWS::ApiGateway::Stage")).forEach((stage) => {
      expect(stage.Properties.CacheClusterEnabled).toBeUndefined();
      (stage.Properties.MethodSettings ?? []).forEach((setting: Record<string, unknown>) => {
        expect(setting.CachingEnabled).toBeUndefined();
      });
    });

    const [resourceId] = Object.keys(templates.userApiTemplate.findResources("AWS::ApiGateway::Resource", {
      Properties: { PathPart: "bills-manifest" },
    }));
    const methods = Object.values(templates.userApiTemplate.findResources("AWS::ApiGateway::Method", {
      Properties: { ResourceId: { Ref: resourceId }, HttpMethod: "GET" },
    }));
    expect(methods).toHaveLength(1);
    expect(methods[0].Properties.RequestValidatorId).toBeUndefined();
    expect(methods[0].Properties.RequestParameters).toBeUndefined();
    expect(methods[0].Properties.Integration.Type).toBe("AWS_PROXY");
  });

  // ── CAP-03: weekly digest fan-out ────────────────────────────────────────

  const queueLogicalId = (queueName: string): string => {
    const ids = Object.keys(templates.userApiTemplate.findResources("AWS::SQS::Queue", {
      Properties: { QueueName: queueName },
    }));
    expect(ids).toHaveLength(1);
    return ids[0];
  };

  test("queues weekly digest work with a 720 s visibility timeout and a 3-receive, 14-day DLQ", () => {
    const dlqId = queueLogicalId("WeeklyDigestDLQ");
    templates.userApiTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "WeeklyDigestDLQ",
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
    });
    templates.userApiTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "WeeklyDigestQueue",
      VisibilityTimeout: 720,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        deadLetterTargetArn: { "Fn::GetAtt": [dlqId, "Arn"] },
        maxReceiveCount: 3,
      },
    });
  });

  test("WeeklyDigestWorker gets the planner's generation settings without UserPII or the queue URL", () => {
    templates.userApiTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "WeeklyDigestWorker",
      MemorySize: 1024,
      Timeout: 120,
      ReservedConcurrentExecutions: Match.absent(),
    });
    const planner = functionEnvironment("GenerateWeeklyDigests");
    const worker = functionEnvironment("WeeklyDigestWorker");

    expect(planner.WEEKLY_DIGEST_QUEUE_URL).toEqual({ Ref: queueLogicalId("WeeklyDigestQueue") });
    const { PII_TABLE_NAME, PII_PARTITION_KEY, WEEKLY_DIGEST_QUEUE_URL, ...plannerGenerationSettings } = planner;
    expect([PII_TABLE_NAME, PII_PARTITION_KEY]).toEqual(["UserPII", "userId"]);
    expect(WEEKLY_DIGEST_QUEUE_URL).toBeDefined();
    // Identical, including the CANONICAL_* schedule settings the worker checks window ids against.
    expect(worker).toEqual(plannerGenerationSettings);
    expect(worker).toEqual(expect.objectContaining({
      CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
      CANONICAL_PUBLISH_HOUR: "10",
      CANONICAL_PUBLISH_MINUTE: "0",
    }));
  });

  test("the planner may send to the digest queue and the worker consumes it from its prod alias", () => {
    const queueArn = { "Fn::GetAtt": [queueLogicalId("WeeklyDigestQueue"), "Arn"] };
    const sqsStatements = (functionName: string) => roleStatements(functionName)
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith("sqs:")));

    // Besides the digest queue, the planner may only send its own failure record (C1.1).
    expect(sqsStatements("GenerateWeeklyDigests")).toEqual([
      expect.objectContaining({ Action: expect.arrayContaining(["sqs:SendMessage"]), Resource: queueArn }),
      expect.objectContaining({
        Action: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
        Resource: { "Fn::Join": ["", expect.arrayContaining([":ScheduledJobFailures"])] },
      }),
    ]);
    expect(sqsStatements("GenerateWeeklyDigests").flatMap(actionsOf)).not.toContain("sqs:ReceiveMessage");
    const workerSqs = sqsStatements("WeeklyDigestWorker");
    expect(workerSqs.length).toBeGreaterThan(0);
    workerSqs.forEach((statement) => {
      expect(statement.Resource).toEqual(queueArn);
      expect(actionsOf(statement)).not.toContain("sqs:SendMessage");
    });
    expect(workerSqs.flatMap(actionsOf)).toEqual(expect.arrayContaining(["sqs:ReceiveMessage", "sqs:DeleteMessage"]));

    const mappings = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::EventSourceMapping"))
      .filter((mapping) => JSON.stringify(mapping.Properties.EventSourceArn) === JSON.stringify(queueArn));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].Properties).toEqual(expect.objectContaining({
      EventSourceArn: queueArn,
      BatchSize: 1,
      Enabled: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
    }));
    expect(mappings[0].Properties.MaximumBatchingWindowInSeconds).toBeUndefined();
    expect(JSON.stringify(mappings[0].Properties.FunctionName)).toMatch(/WeeklyDigestWorkerProdAlias[^"]*"\}\]\}\]\},":prod"/);
  });

  test("WeeklyDigestWorker publishes only its metric namespace", () => {
    expect(roleStatements("WeeklyDigestWorker")).toEqual(expect.arrayContaining([
      {
        Action: "cloudwatch:PutMetricData",
        Effect: "Allow",
        Resource: "*",
        Condition: { StringEquals: { "cloudwatch:namespace": "BillBoard/WeeklyDigest" } },
      },
    ]));
    expect(roleStatements("WeeklyDigestWorker").flatMap(actionsOf)
      .filter((action) => /^(sns|kms|secretsmanager|cognito-idp):/.test(action))).toEqual([]);
  });

  // CQ-15: the store tables and buckets are granted here by their fixed names.
  describe("data store access", () => {
    const storeAccessOf = (functionName: string) => storeActions(roleStatements(functionName));
    const writtenBy = (functionName: string) => Object.entries(storeAccessOf(functionName))
      .filter(([, actions]) => actions.some(isDataWrite))
      .map(([resource]) => resource);
    const billStore = [`bucket/${BILL_STORE_BUCKET_NAME}`, `bucket/${BILL_STORE_BUCKET_NAME}/*`];

    // CAP-03: the worker builds the digests its message names; the planner alone lists users
    // (UserPII), and digest generation never reads BillStats (C1.7 removed the planner's unused read).
    test("WeeklyDigestWorker reads preferences, feedback, the manifests and the bill store, and writes only digests", () => {
      expect(Object.keys(storeAccessOf("WeeklyDigestWorker"))).toEqual([
        ...billStore,
        "table/BillsManifest",
        "table/CongressMembersManifest",
        "table/UserFeedback",
        "table/UserFeedback/index/*",
        "table/UserPreferences",
        "table/UserPreferences/index/*",
        "table/UserWeeklyDigests",
      ]);
      expect(writtenBy("WeeklyDigestWorker")).toEqual(["table/UserWeeklyDigests"]);
    });

    test("GenerateWeeklyDigests also lists UserPII, reads no BillStats, and writes only digests", () => {
      expect(Object.keys(storeAccessOf("GenerateWeeklyDigests"))).toEqual([
        ...billStore,
        "table/BillsManifest",
        "table/CongressMembersManifest",
        "table/UserFeedback",
        "table/UserFeedback/index/*",
        "table/UserPII",
        "table/UserPreferences",
        "table/UserPreferences/index/*",
        "table/UserWeeklyDigests",
      ]);
      expect(storeAccessOf("GenerateWeeklyDigests")["table/UserPII"]).toEqual(expect.arrayContaining(["dynamodb:Scan"]));
      expect(writtenBy("GenerateWeeklyDigests")).toEqual(["table/UserWeeklyDigests"]);
    });

    // APPF-03: FetchCongressMembersManifest (BatchGetItem) and FetchProcessedCongressMembers (GetItem)
    // add trackedSponsoredCount and trackedSupportedCount from the stats table.
    test("both member readers read the stats table and write nothing", () => {
      ["FetchCongressMembersManifest", "FetchProcessedCongressMembers"].forEach((functionName) => {
        expect({ functionName, stats: storeAccessOf(functionName)["table/CongressMembersStats"] }).toEqual({
          functionName,
          stats: expect.arrayContaining(["dynamodb:GetItem", "dynamodb:BatchGetItem"]),
        });
        expect({ functionName, writes: writtenBy(functionName) }).toEqual({ functionName, writes: [] });
      });
    });

    // C1.6 step 1 changes only the code: both deleters keep their BillStats write until step 2
    // removes it with STATS_*, once no rollback target can still recompute inline.
    test("the account deleters write every user table, and only they write UserPII besides the PII handlers", () => {
      const userTables = [
        "table/BillStats",
        "table/UserDevices",
        "table/UserFeedback",
        "table/UserPII",
        "table/UserPreferences",
        "table/UserWeeklyDigests",
      ];
      // X5: AccountData also releases the address and email claims and deletes the App Attest bindings. X23:
      // CleanupOrphanedUsers only reads those three tables until its DRY_RUN=false change, except that
      // REL-53's 'delete' mode lets it delete email claims (DeleteItem on SignUpEmailClaims).
      const deletionTables = ["table/AppAttest", "table/SignUpEmailClaims", "table/VerifiedAddressClaims"];
      const writtenTables = (functionName: string) => writtenBy(functionName).filter((resource) => !resource.endsWith("/index/*"));
      expect(writtenTables("AccountData")).toEqual([...userTables, ...deletionTables].sort());
      expect(writtenTables("CleanupOrphanedUsers")).toEqual(
        [...userTables, ...(UNCONFIRMED_SIGNUP_CLEANUP_MODE === "delete" ? ["table/SignUpEmailClaims"] : [])].sort(),
      );
      const piiWriters = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function"))
        .map((fn) => fn.Properties.FunctionName as string | undefined)
        .filter((functionName): functionName is string => functionName !== undefined)
        .filter((functionName) => writtenBy(functionName).includes("table/UserPII"))
        .sort();
      // INT-06: SetFeedback's daily vote counter is one UpdateItem on the caller's UserPII row. UX-31: so is
      // FetchCivicScore's Civic Score record.
      expect(piiWriters).toEqual([
        "AccountData",
        "AdultAttestation",
        "CleanupOrphanedUsers",
        "DistrictVerification",
        "FetchCivicScore",
        "SetFeedback",
      ]);
      expect(storeAccessOf("SetFeedback")["table/UserPII"].filter(isDataWrite)).toEqual(["dynamodb:UpdateItem"]);
      expect(storeAccessOf("FetchCivicScore")["table/UserPII"].filter(isDataWrite)).toEqual(["dynamodb:UpdateItem"]);
    });

    // INT-11: results (any aggregate of Billboard users' votes) are served only by the Cognito GET /bill-stats,
    // after the caller's own vote. The functions behind the unauthenticated methods (the share site's
    // /public/processed-bill and App Attest) can read no vote row, no stats document and no manifest row
    // carrying a vote count: at most the companion groups row of BillsManifest.
    test("the functions behind the unauthenticated methods cannot read votes, bill stats or manifest vote counts", () => {
      const resources = templates.userApiTemplate.toJSON().Resources as Record<string, Record<string, any>>;
      const publicFunctions = Object.values(resources)
        .filter((resource) => resource.Type === "AWS::ApiGateway::Method")
        .filter((method) => method.Properties.AuthorizationType === "NONE" && method.Properties.Integration?.Type === "AWS_PROXY")
        .flatMap((method) => [...JSON.stringify(method.Properties.Integration.Uri).matchAll(/"Ref":"([A-Za-z0-9]+)"/g)])
        .map(([, logicalId]) => resources[logicalId])
        .filter((resource) => resource?.Type === "AWS::Lambda::Alias")
        .map((alias) => resources[alias.Properties.FunctionName.Ref].Properties.FunctionName as string);
      expect([...new Set(publicFunctions)].sort()).toEqual(["AppAttest", "FetchProcessedBill"]);

      [...new Set(publicFunctions)].forEach((functionName) => {
        const tables = Object.keys(storeAccessOf(functionName)).filter((resource) => resource.startsWith("table/"));
        expect({ functionName, votes: tables.filter((table) => /^table\/(UserFeedback|BillStats)(\/|$)/.test(table)) })
          .toEqual({ functionName, votes: [] });
        const manifestGrants = roleStatements(functionName)
          .filter((statement) => JSON.stringify(statement.Resource).includes("table/BillsManifest"));
        expect({ functionName, manifest: partitionScopedGrants(manifestGrants).length }).toEqual({
          functionName,
          manifest: manifestGrants.length,
        });
        partitionScopedGrants(manifestGrants).forEach((grant) =>
          expect(grant.condition).toEqual(leadingKeysCondition("BILL_COMPANION_GROUPS")),
        );
      });
    });

    test("PublishBillsManifest and FetchBillsManifest read BillsManifest, and only the publisher writes, only the companion groups row", () => {
      ["PublishBillsManifest", "FetchBillsManifest"].forEach((functionName) => {
        expect({ functionName, access: Object.keys(storeAccessOf(functionName)) })
          .toEqual({ functionName, access: ["table/BillsManifest"] });
      });
      expect(writtenBy("FetchBillsManifest")).toEqual([]);
      expect(writtenBy("PublishBillsManifest")).toEqual(["table/BillsManifest"]);
      expect(partitionScopedGrants(roleStatements("PublishBillsManifest")).flatMap((grant) => grant.actions))
        .toEqual(["dynamodb:PutItem"]);
    });
  });

  // ── APPF-23: companion bills ──────────────────────────────────────────────

  describe("companion bills (APPF-23)", () => {
    const allFunctionNames = (): string[] =>
      Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function"))
        .map((fn) => fn.Properties.FunctionName as string | undefined)
        .filter((functionName): functionName is string => functionName !== undefined);
    const manifestStatements = (functionName: string) => roleStatements(functionName)
      .filter((statement) => JSON.stringify(statement.Resource).includes("table/BillsManifest"));

    test("the kill switch has its intended value, and only PublishBillsManifest reads it", () => {
      expect(COMPANION_GROUPS_ENABLED).toBe("true");
      expect(functionEnvironment("PublishBillsManifest").COMPANION_GROUPS_ENABLED).toBe(COMPANION_GROUPS_ENABLED);
      expect(allFunctionNames().filter((functionName) => "COMPANION_GROUPS_ENABLED" in (functionEnvironment(functionName) ?? {})))
        .toEqual(["PublishBillsManifest"]);
    });

    test.each([
      "FetchBillsManifest",
      "PublishBillsManifest",
      "FetchProcessedBill",
      "FetchBillStats",
      "FetchCivicScore",
      "FetchCivicProfile",
      "GenerateWeeklyDigests",
      "WeeklyDigestWorker",
    ])("%s knows the companion rows' table and keys", (functionName) => {
      expect(functionEnvironment(functionName)).toEqual(expect.objectContaining(companionEnvironment));
    });

    test("no other user API function gets the companion keys", () => {
      const withKeys = allFunctionNames()
        .filter((functionName) => "MANIFEST_COMPANION_GROUPS_PK" in (functionEnvironment(functionName) ?? {}))
        .sort();
      expect(withKeys).toEqual([
        "FetchBillStats",
        "FetchBillsManifest",
        "FetchCivicProfile",
        "FetchCivicScore",
        "FetchProcessedBill",
        "GenerateWeeklyDigests",
        "PublishBillsManifest",
        "WeeklyDigestWorker",
      ]);
    });

    // These had no BillsManifest access before: they get GetItem on the groups row and nothing else.
    test.each(["FetchProcessedBill", "FetchBillStats", "FetchCivicScore"])(
      "%s may only GetItem the companion groups row in BillsManifest",
      (functionName) => {
        expect(manifestStatements(functionName)).toHaveLength(1);
        expect(partitionScopedGrants(roleStatements(functionName))).toEqual([
          { resource: "table/BillsManifest", actions: ["dynamodb:GetItem"], condition: leadingKeysCondition("BILL_COMPANION_GROUPS") },
        ]);
      },
    );

    // These already read the whole manifest table, which covers the groups row; no new grant.
    test.each(["FetchBillsManifest", "FetchCivicProfile", "GenerateWeeklyDigests", "WeeklyDigestWorker"])(
      "%s reads the groups row through its existing BillsManifest read grant and writes no manifest row",
      (functionName) => {
        expect(partitionScopedGrants(roleStatements(functionName))).toEqual([]);
        expect(storeActions(roleStatements(functionName))["table/BillsManifest"]).toEqual(
          expect.arrayContaining(["dynamodb:GetItem", "dynamodb:Query"]),
        );
        expect(storeActions(roleStatements(functionName))["table/BillsManifest"].filter(isDataWrite)).toEqual([]);
      },
    );

    // scope=companions with no stored group document folds the members' votes on the fly. INT-11: the handler
    // reads the caller's own rows on the table with BatchGetItem before any stats, and uses no GetItem there.
    test("FetchBillStats may Query the feedback bill-id index and BatchGetItem rows by key, and nothing else in UserFeedback", () => {
      const access = storeActions(roleStatements("FetchBillStats"));
      expect(Object.keys(access)).toEqual([
        "table/BillStats",
        "table/BillsManifest",
        "table/UserFeedback",
        "table/UserFeedback/index/GSIBillIdIndex",
      ]);
      expect(access["table/UserFeedback"]).toEqual(["dynamodb:BatchGetItem"]);
      expect(access["table/UserFeedback/index/GSIBillIdIndex"]).toEqual(["dynamodb:Query"]);
      expect(Object.values(access).flat().filter(isDataWrite)).toEqual([]);
      expect(functionEnvironment("FetchBillStats")).toEqual(expect.objectContaining({
        STATS_TABLE_NAME: "BillStats",
        STATS_PARTITION_KEY: "billId",
        FEEDBACK_TABLE_NAME: "UserFeedback",
        FEEDBACK_PARTITION_KEY: "userId",
        FEEDBACK_SORT_KEY: "billId",
        FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
      }));
    });

    test("GET /bill-stats passes the scope query parameter through to FetchBillStats", () => {
      const [resourceId] = Object.keys(templates.userApiTemplate.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "bill-stats" },
      }));
      const methods = Object.values(templates.userApiTemplate.findResources("AWS::ApiGateway::Method", {
        Properties: { ResourceId: { Ref: resourceId }, HttpMethod: "GET" },
      }));
      expect(methods).toHaveLength(1);
      expect(methods[0].Properties.RequestValidatorId).toBeUndefined();
      expect(methods[0].Properties.RequestParameters).toBeUndefined();
      expect(methods[0].Properties.Integration.Type).toBe("AWS_PROXY");
    });
  });
});

// ── Account integrity (C2-F with the integration plan's X3, X4, X5, X8, X21) ──────────────────────────

type CfnTemplate = { Resources: Record<string, Record<string, any>>; Outputs?: Record<string, unknown> };

/**
 * Every cycle among a template's resources, following Ref, Fn::GetAtt, ${...} in Fn::Sub and DependsOn.
 * CDK does not check references inside one stack for cycles; CloudFormation rejects the template at deploy.
 */
const dependencyCycles = (template: CfnTemplate): string[][] => {
  const ids = new Set(Object.keys(template.Resources));
  const referencesIn = (value: unknown, found: Set<string>): Set<string> => {
    if (Array.isArray(value)) {
      value.forEach((entry) => referencesIn(entry, found));
    } else if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
        if (key === "Ref" && typeof entry === "string" && ids.has(entry)) found.add(entry);
        else if (key === "Fn::GetAtt") {
          const target = Array.isArray(entry) ? entry[0] : String(entry).split(".")[0];
          if (ids.has(target)) found.add(target);
        } else if (key === "Fn::Sub") {
          const text = Array.isArray(entry) ? entry[0] : entry;
          [...String(text).matchAll(/\$\{([^}.!]+)/g)].forEach((match) => ids.has(match[1]) && found.add(match[1]));
          if (Array.isArray(entry)) referencesIn(entry[1], found);
        } else {
          referencesIn(entry, found);
        }
      });
    }
    return found;
  };
  const edges = new Map<string, string[]>(
    Object.entries(template.Resources).map(([id, resource]) => [
      id,
      [...referencesIn({ properties: resource.Properties, dependsOn: [resource.DependsOn ?? []].flat().map((dep: string) => ({ Ref: dep })) }, new Set())],
    ]),
  );
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    (edges.get(id) ?? []).forEach((next) => visit(next, [...path, id]));
    state.set(id, "done");
  };
  [...edges.keys()].forEach((id) => visit(id, []));
  return cycles;
};

// The user pool exactly as U9 left it (isolated synth, so without the app's tags). The pre-sign-up trigger may add
// LambdaConfig and nothing else (X21): an in-place pool update writes every property in the template.
const U9_USER_POOL_PROPERTIES = {
  AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
  AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
  AutoVerifiedAttributes: ["email"],
  DeletionProtection: "ACTIVE",
  EmailVerificationMessage: "Thanks for signing up for BillBoard! Your verification code is {####}",
  EmailVerificationSubject: "Verify your email for BillBoard!",
  EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
  MfaConfiguration: "OPTIONAL",
  Schema: [
    { Mutable: true, Name: "email", Required: true },
    { Mutable: true, Name: "address", Required: false },
    { Mutable: true, Name: "given_name", Required: false },
    { Mutable: true, Name: "family_name", Required: false },
    { AttributeDataType: "String", Mutable: true, Name: "state", StringAttributeConstraints: { MaxLength: "2" } },
    { AttributeDataType: "String", Mutable: true, Name: "district", StringAttributeConstraints: { MaxLength: "16" } },
    { AttributeDataType: "String", Mutable: true, Name: "politicalParty", StringAttributeConstraints: { MaxLength: "32" } },
  ],
  SmsVerificationMessage: "The verification code to your new account is {####}",
  UserPoolName: "BillboardUserPool",
  UsernameAttributes: ["email"],
  VerificationMessageTemplate: {
    DefaultEmailOption: "CONFIRM_WITH_CODE",
    EmailMessage: "Thanks for signing up for BillBoard! Your verification code is {####}",
    EmailSubject: "Verify your email for BillBoard!",
    SmsMessage: "The verification code to your new account is {####}",
  },
};

// REL-54 step 2 (docs/RUNBOOK.md 23.4): the four email properties since the pool sends through SES, as the isolated
// synth writes them (no account or region, so the identity's ARN is built from the stack's own). The subject, body,
// From and Reply-To are the project's (2026-10-29), word for word. The app's literal values, and the proof that the
// pool otherwise matches main's, are in app-wide-invariants.test.ts.
const REL54_STEP2_EMAIL_PROPERTIES = {
  EmailConfiguration: {
    ConfigurationSet: "BillboardAccountEmail",
    EmailSendingAccount: "DEVELOPER",
    From: "Billboard <no-reply@billboard-project.com>",
    ReplyToEmailAddress: "contact@billboard-project.com",
    SourceArn: {
      "Fn::Join": ["", [
        "arn:", { Ref: "AWS::Partition" }, ":ses:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" },
        ":identity/billboard-project.com",
      ]],
    },
  },
  EmailVerificationMessage: "Your Billboard verification code is {####}. Enter it in the app to continue. If you didn't ask for this code, you can ignore this email.",
  EmailVerificationSubject: "Your Billboard verification code",
  VerificationMessageTemplate: {
    DefaultEmailOption: "CONFIRM_WITH_CODE",
    EmailMessage: "Your Billboard verification code is {####}. Enter it in the app to continue. If you didn't ask for this code, you can ignore this email.",
    EmailSubject: "Your Billboard verification code",
    SmsMessage: "The verification code to your new account is {####}",
  },
};
const REL54_STEP2_PROPERTY_NAMES = Object.keys(REL54_STEP2_EMAIL_PROPERTIES);

/** The pool without its PreSignUp trigger: U9's properties with REL-54 step 2's email properties. */
const USER_POOL_PROPERTIES_WITHOUT_TRIGGER = { ...U9_USER_POOL_PROPERTIES, ...REL54_STEP2_EMAIL_PROPERTIES };

const ABUSE_LIMITS_MODULE = "../lib/config/abuse-limits";

/**
 * UserAPIServiceStack synthesized with some section 6 constants set to other values, the way a flip PR
 * changes them: each named constants module is replaced for this one synth only.
 */
const synthUserApiWithModules = (overridesByModule: Record<string, Record<string, unknown>>): CfnTemplate => {
  let template: CfnTemplate | undefined;
  jest.isolateModules(() => {
    Object.entries(overridesByModule).forEach(([modulePath, overrides]) =>
      jest.doMock(modulePath, () => ({ ...jest.requireActual(modulePath), ...overrides })));
    try {
      const isolatedCdk = require("aws-cdk-lib") as typeof import("aws-cdk-lib");
      const isolatedDdb = require("aws-cdk-lib/aws-dynamodb") as typeof import("aws-cdk-lib/aws-dynamodb");
      const assertions = require("aws-cdk-lib/assertions") as typeof import("aws-cdk-lib/assertions");
      const { SharedInfraStack } = require("../lib/stacks/shared-infra") as typeof import("../lib/stacks/shared-infra");
      const { UserAPIServiceStack } = require("../lib/stacks/user-api-service") as typeof import("../lib/stacks/user-api-service");
      const app = new isolatedCdk.App();
      const shared = new SharedInfraStack(app, "SharedInfraStack");
      const deps = new isolatedCdk.Stack(app, "UserApiDeps");
      const billPriorityTable = new isolatedDdb.Table(deps, "BillPriorityTable", {
        partitionKey: { name: "guid", type: isolatedDdb.AttributeType.STRING },
        billingMode: isolatedDdb.BillingMode.PAY_PER_REQUEST,
      });
      const stack = new UserAPIServiceStack(app, "UserAPIServiceStack", {
        lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
        billPriorityTable,
      });
      template = assertions.Template.fromStack(stack).toJSON() as CfnTemplate;
    } finally {
      Object.keys(overridesByModule).forEach((modulePath) => jest.dontMock(modulePath));
    }
  });
  return template!;
};

/** The same, with abuse-limits.ts values changed (the section 6 and App Attest switches and limits). */
const synthUserApiWithAbuseLimits = (overrides: Record<string, unknown>): CfnTemplate =>
  synthUserApiWithModules({ [ABUSE_LIMITS_MODULE]: overrides });

/** Resources added, removed and changed between two templates, with function versions' hashes ignored. */
const templateChanges = (before: CfnTemplate, after: CfnTemplate) => {
  const normalize = (template: CfnTemplate): Record<string, string> =>
    Object.fromEntries(
      Object.entries(template.Resources).map(([id, resource]) => [
        id.replace(/CurrentVersion[0-9A-F]{8}[0-9a-f]{32,40}$/, "CurrentVersion"),
        JSON.stringify(resource).replace(/CurrentVersion[0-9A-F]{8}[0-9a-f]{32,40}/g, "CurrentVersion"),
      ]),
    );
  const left = normalize(before);
  const right = normalize(after);
  return {
    added: Object.keys(right).filter((id) => !(id in left)).sort(),
    removed: Object.keys(left).filter((id) => !(id in right)).sort(),
    changed: Object.keys(right).filter((id) => id in left && left[id] !== right[id]).sort(),
  };
};

describe("UserAPIServiceStack, account integrity", () => {
  const template = (): CfnTemplate => templates.userApiTemplate.toJSON() as CfnTemplate;
  const statementsOf = (functionName: string) => roleStatementsOf(templates.userApiTemplate, functionName);
  const actionsOf = (statement: Record<string, any>): string[] => [statement.Action].flat();
  const functionNamed = (functionName: string): [string, Record<string, any>] => {
    const matches = Object.entries(templates.userApiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: functionName },
    }));
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const environmentOf = (functionName: string): Record<string, unknown> => functionNamed(functionName)[1].Properties.Environment.Variables;
  const logicalIdOf = (type: string, prefix: string): string => {
    const ids = Object.keys(templates.userApiTemplate.findResources(type)).filter((id) => new RegExp(`^${prefix}[0-9A-F]{8}$`).test(id));
    expect(ids).toHaveLength(1);
    return ids[0];
  };
  const deploymentGroupOf = (functionName: string): Record<string, any> =>
    templates.userApiTemplate.findResources("AWS::CodeDeploy::DeploymentGroup")[logicalIdOf("AWS::CodeDeploy::DeploymentGroup", `${functionName}DeploymentGroup`)];
  const saltSecretId = (): string => logicalIdOf("AWS::SecretsManager::Secret", "DistrictVerificationHashSaltSecret");
  const probeTokenSecretId = (): string => logicalIdOf("AWS::SecretsManager::Secret", "SignUpProbeTokenSecret");
  const userPoolId = (): string => logicalIdOf("AWS::Cognito::UserPool", "BillboardUserPool");
  const aliasId = (functionName: string): string => logicalIdOf("AWS::Lambda::Alias", `${functionName}ProdAlias`);
  const queueId = (queueName: string): string => {
    const ids = Object.keys(templates.userApiTemplate.findResources("AWS::SQS::Queue", { Properties: { QueueName: queueName } }));
    expect(ids).toHaveLength(1);
    return ids[0];
  };

  describe("INT-05: PreSignUpCheck (X4, X5)", () => {
    test("is release-backed, 256 MB, 5 s (Cognito's limit), with exactly its mode, claims table and salt secret", () => {
      const [, fn] = functionNamed("PreSignUpCheck");
      expect(fn.Properties).toEqual(expect.objectContaining({
        Handler: "dist/index.handler",
        Runtime: "nodejs24.x",
        MemorySize: 256,
        Timeout: 5,
        TracingConfig: { Mode: "Active" },
      }));
      // No USER_POOL_ID (the handler reads the pool from the event; a reference would be a cycle) and no
      // plaintext HASH_SALT. The App Attest and DeviceCheck settings are C3's (C3 3.1).
      expect(environmentOf("PreSignUpCheck")).toEqual({
        SIGNUP_FILTER_MODE,
        SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
        HASH_SALT_SECRET_ARN: { Ref: saltSecretId() },
        APP_ATTEST_MODE: APP_ATTEST_SIGN_UP_MODE,
        APP_ATTEST_TABLE_NAME: "AppAttest",
        APP_ATTEST_ALLOWED_ENVIRONMENTS,
        APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(APP_ATTEST_MAX_ACCOUNTS_PER_KEY),
        APP_ATTEST_FAIL_CLOSED: String(APP_ATTEST_FAIL_CLOSED),
        DEVICE_CHECK_MODE,
        DEVICE_CHECK_SECRET_NAME: "Billboard/AppleDeviceCheckKey",
        DEVICE_MAX_ACCOUNTS: String(DEVICE_MAX_ACCOUNTS),
        DEVICE_COUNTER_WINDOW_MONTHS: String(DEVICE_COUNTER_WINDOW_MONTHS),
        ...(MIN_APP_VERSION ? { MIN_APP_VERSION } : {}),
        // CB-07: the filter check's address, so its sign-ups are labelled probes, when they carry the probe token
        // whose secret this names (INF-15).
        SIGNUP_FILTER_CHECK_ADDRESS,
        SIGNUP_PROBE_TOKEN_SECRET_ARN: { Ref: probeTokenSecretId() },
      });
    });

    test("may read the salt and the DeviceCheck key, use its claims table and the App Attest table, and AdminGetUser the pool, nothing more", () => {
      const statements = statementsOf("PreSignUpCheck");
      // INT-04: sign-up consumes a challenge, reads the key and counts its sign-ups; it never creates a binding.
      expect(storeActions(statements)).toEqual({
        "table/AppAttest": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        "table/SignUpEmailClaims": ["dynamodb:GetItem", "dynamodb:PutItem"],
      });
      const secretStatements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("secretsmanager:")));
      expect(secretStatements.map((statement) => ({ actions: actionsOf(statement).sort(), resource: statement.Resource }))).toEqual([
        { actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], resource: { Ref: saltSecretId() } },
        { actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], resource: { Ref: probeTokenSecretId() } },
        // By name, with Secrets Manager's six-character suffix: the secret does not exist until its key is made by hand.
        {
          actions: ["secretsmanager:GetSecretValue"],
          resource: {
            "Fn::Join": ["", [
              "arn:", { Ref: "AWS::Partition" }, ":secretsmanager:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" },
              ":secret:Billboard/AppleDeviceCheckKey-??????",
            ]],
          },
        },
      ]);
      const cognitoStatements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("cognito-idp:")));
      expect(cognitoStatements).toEqual([
        { Action: "cognito-idp:AdminGetUser", Effect: "Allow", Resource: { "Fn::GetAtt": [userPoolId(), "Arn"] } },
      ]);
      expect(statements.flatMap(actionsOf).filter((action) => /^(sqs|sns|s3|kms|cloudwatch):/.test(action))).toEqual([]);
      // Besides PreSignUpCheck, only the account deletion touches the sign-up claims (X5 (b); Cleanup reads, X23), and
      // the filter check deletes what its own sign-ups made (CB-07).
      const grantees = Object.values(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
        .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes("table/SignUpEmailClaims"))
        .flatMap((policy) => policy.Properties.Roles.map((role: { Ref: string }) => role.Ref.replace(/ServiceRole[0-9A-F]{8}$/, "")))
        .sort();
      expect(grantees).toEqual(["AccountData", "CleanupOrphanedUsers", "PreSignUpCheck", "SignUpFilterCheck"]);
    });

    // Under enforce a refused sign-up is a thrown error, and the filter check (CB-07) refuses one every day at 11:30
    // UTC. The canary's rollback alarm counts Errors less those refusals, so a deploy needs no time window.
    test("its rollback alarm is Errors less SignUpRejected and SignUpProbeRejected, the refusals it writes before it throws", () => {
      expect(PRE_SIGN_UP_CHECK_INTENTIONAL_ERROR_METRICS).toEqual(["SignUpRejected", "SignUpProbeRejected"]);
      const alarms = Object.entries(templates.userApiTemplate.findResources("AWS::CloudWatch::Alarm"));
      const [alarmId, alarm] = alarms.find(([logicalId]) => logicalId.startsWith("PreSignUpCheckAliasErrorAlarm"))!;
      expect(alarm.Properties).toMatchObject({ Threshold: 1, EvaluationPeriods: 1, TreatMissingData: "notBreaching" });
      const queries: any[] = alarm.Properties.Metrics;
      expect(queries.find((query) => query.ReturnData !== false).Expression)
        .toBe("errors - FILL(intentional0, 0) - FILL(intentional1, 0)");
      const metricOf = (id: string) => queries.find((query) => query.Id === id).MetricStat;
      expect(metricOf("errors")).toMatchObject({ Metric: { Namespace: "AWS/Lambda", MetricName: "Errors" }, Period: 60, Stat: "Sum" });
      expect(JSON.stringify(metricOf("errors").Metric.Dimensions)).toMatch(/PreSignUpCheck.*:prod/);
      [["intentional0", "SignUpRejected"], ["intentional1", "SignUpProbeRejected"]].forEach(([id, metricName]) =>
        expect(metricOf(id)).toEqual({
          Metric: { Namespace: "BillBoard/AccountIntegrity", MetricName: metricName },
          Period: 60,
          Stat: "Sum",
        }));
      // Still the canary's rollback alarm, beside the API 5XX and Synthetics alarms.
      expect(JSON.stringify(deploymentGroupOf("PreSignUpCheck").Properties.AlarmConfiguration.Alarms)).toContain(alarmId);
      expect(deploymentGroupOf("PreSignUpCheck").Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaCanary10Percent10Minutes");
      // No other function's alias alarm leaves anything out.
      alarms
        .filter(([logicalId]) => /AliasErrorAlarm/.test(logicalId) && !logicalId.startsWith("PreSignUpCheck"))
        .forEach(([logicalId, other]) =>
          expect({ logicalId, metricName: other.Properties.MetricName, metrics: other.Properties.Metrics })
            .toEqual({ logicalId, metricName: "Errors", metrics: undefined }));
      // The names, the namespace and the order (metric line, then the throw) are the filter's.
      const services = path.join(__dirname, "..", "..", "services", "src");
      const preSignUp = fs.readFileSync(path.join(services, "handlers", "preSignUp", "index.ts"), "utf8");
      expect(preSignUp).toContain('rejected: "SignUpRejected"');
      expect(preSignUp).toContain('probeRejected: "SignUpProbeRejected"');
      expect(preSignUp).toMatch(/SIGN_UP_FILTER_METRICS: CheckMetrics = \{\n  namespace: ACCOUNT_INTEGRITY_NAMESPACE,/);
      expect(preSignUp).toContain('export const ACCOUNT_INTEGRITY_NAMESPACE = "BillBoard/AccountIntegrity";');
    });

    // The pool references the alias (its trigger); a reference from the function's default policy, which the
    // function depends on, back to the pool would close a cycle. AdminGetUser therefore sits in its own policy.
    test("AdminGetUser is a standalone policy that the function does not depend on", () => {
      const [functionId, fn] = functionNamed("PreSignUpCheck");
      const policies = Object.entries(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
        .filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes("cognito-idp:AdminGetUser"))
        .filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes("PreSignUpCheckServiceRole"));
      expect(policies.map(([id]) => id)).toEqual([expect.stringMatching(/^PreSignUpCheckUserPoolPolicy[0-9A-F]{8}$/)]);
      expect(fn.DependsOn).not.toContain(policies[0][0]);
      const defaultPolicy = Object.entries(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
        .find(([id]) => /^PreSignUpCheckServiceRoleDefaultPolicy/.test(id))!;
      expect(fn.DependsOn).toContain(defaultPolicy[0]);
      expect(JSON.stringify(defaultPolicy[1])).not.toContain(userPoolId());
      expect(JSON.stringify(fn.Properties)).not.toContain(userPoolId());
      expect(functionId).toMatch(/^PreSignUpCheck[0-9A-F]{8}$/);
    });

    test("is the pool's PreSignUp trigger through its prod alias, invocable by Cognito for this pool only", () => {
      const pool = templates.userApiTemplate.findResources("AWS::Cognito::UserPool")[userPoolId()];
      expect(pool.Properties.LambdaConfig).toEqual({ PreSignUp: { Ref: aliasId("PreSignUpCheck") } });
      const permissions = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Permission"))
        .filter((permission) => permission.Properties.Principal === "cognito-idp.amazonaws.com");
      expect(permissions.map((permission) => permission.Properties)).toEqual([{
        Action: "lambda:InvokeFunction",
        FunctionName: { Ref: aliasId("PreSignUpCheck") },
        Principal: "cognito-idp.amazonaws.com",
        SourceArn: { "Fn::GetAtt": [userPoolId(), "Arn"] },
      }]);
    });

    test("deploys as an API handler: the 10-minute canary with the API 5XX and canary alarms", () => {
      const group = deploymentGroupOf("PreSignUpCheck");
      expect(group.Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaCanary10Percent10Minutes");
      expect(group.Properties.AlarmConfiguration.Alarms).toHaveLength(3);
    });
  });

  describe("the user pool (X21)", () => {
    test("changes only by LambdaConfig (the pre-sign-up trigger) and REL-54 step 2's email: every other property is exactly U9's", () => {
      const pool = templates.userApiTemplate.findResources("AWS::Cognito::UserPool")[userPoolId()];
      const { LambdaConfig, ...rest } = pool.Properties;
      expect(LambdaConfig).toBeDefined();
      expect(rest).toEqual(USER_POOL_PROPERTIES_WITHOUT_TRIGGER);
      const unchanged = (properties: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(properties).filter(([name]) => !REL54_STEP2_PROPERTY_NAMES.includes(name)));
      expect(unchanged(rest)).toEqual(unchanged(U9_USER_POOL_PROPERTIES));
      expect(pool.DeletionPolicy).toBe("Retain");
      expect(pool.UpdateReplacePolicy).toBe("Retain");
    });

    // REL-54 step 2: Cognito sends every code through SES on EmailStack's identity, with the project's copy.
    test("sends through SES (DEVELOPER) with the project's sender, Reply-To, configuration set and copy", () => {
      const pool = templates.userApiTemplate.findResources("AWS::Cognito::UserPool")[userPoolId()];
      expect(pool.Properties).toMatchObject(REL54_STEP2_EMAIL_PROPERTIES);
      // No CustomMessage, CustomEmailSender or other email trigger: the one verification template is every code's.
      expect(Object.keys(pool.Properties.LambdaConfig)).toEqual(["PreSignUp"]);
      // No invitation template either: only hand-made accounts (AdminCreateUser) would use one.
      expect(pool.Properties.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: false });
      // The identity is named by ARN and the set by name: nothing SES lives in this stack, and nothing is imported.
      expect(JSON.stringify(template())).not.toContain('"AWS::SES::');
      expect(JSON.stringify(pool)).not.toContain("Fn::ImportValue");
    });

    test("the pool and both clients keep their logical IDs, so nothing is replaced", () => {
      expect(Object.keys(templates.userApiTemplate.findResources("AWS::Cognito::UserPool"))).toEqual(["BillboardUserPoolC41FE3DD"]);
      expect(Object.keys(templates.userApiTemplate.findResources("AWS::Cognito::UserPoolClient")).sort()).toEqual([
        "BillboardUserPoolBillboardCanaryClient2EACA7EB",
        "BillboardUserPoolUserPoolClient61DEF7CD",
      ]);
    });

    test("the stack's resources form no dependency cycle (pool, trigger alias, function and policies)", () => {
      expect(dependencyCycles(template())).toEqual([]);
    });

    test("the cycle check finds a cycle when there is one", () => {
      expect(dependencyCycles({
        Resources: {
          Pool: { Properties: { LambdaConfig: { PreSignUp: { Ref: "Alias" } } } },
          Alias: { Properties: { FunctionName: { Ref: "Fn" } } },
          Fn: { Properties: {}, DependsOn: ["Policy"] },
          Policy: { Properties: { Resource: { "Fn::GetAtt": ["Pool", "Arn"] } } },
        },
      })).toEqual([["Pool", "Alias", "Fn", "Policy", "Pool"]]);
    });
  });

  describe("INT-03: verification limits and the vote re-stamp (X8)", () => {
    test("RestampUserVotesQueue: 360 s visibility, SSE, 5 receives into a 14-day DLQ", () => {
      const dlqId = queueId("RestampUserVotesDLQ");
      templates.userApiTemplate.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "RestampUserVotesDLQ",
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
        SqsManagedSseEnabled: true,
      });
      templates.userApiTemplate.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "RestampUserVotesQueue",
        VisibilityTimeout: 360,
        SqsManagedSseEnabled: true,
        RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [dlqId, "Arn"] }, maxReceiveCount: 5 },
      });
    });

    test("RestampUserVotes is a worker in plan mode that reads UserPII and stamps UserFeedback rows only", () => {
      const [, fn] = functionNamed("RestampUserVotes");
      expect(fn.Properties).toEqual(expect.objectContaining({ Handler: "dist/index.handler", MemorySize: 256, Timeout: 60 }));
      expect(environmentOf("RestampUserVotes")).toEqual({
        PII_TABLE_NAME: "UserPII",
        PII_PARTITION_KEY: "userId",
        FEEDBACK_TABLE_NAME: "UserFeedback",
        FEEDBACK_PARTITION_KEY: "userId",
        FEEDBACK_SORT_KEY: "billId",
        VOTE_RESTAMP_MODE: "plan",
      });
      expect(storeActions(statementsOf("RestampUserVotes"))).toEqual({
        "table/UserFeedback": ["dynamodb:Query", "dynamodb:UpdateItem"],
        "table/UserPII": ["dynamodb:GetItem"],
      });
      expect(deploymentGroupOf("RestampUserVotes").Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaAllAtOnce");
      expect(deploymentGroupOf("RestampUserVotes").Properties.AlarmConfiguration.Alarms).toHaveLength(1);
    });

    test("RestampUserVotes consumes its queue from the prod alias, one message at a time, at most 2 at once", () => {
      const queueArn = { "Fn::GetAtt": [queueId("RestampUserVotesQueue"), "Arn"] };
      const mappings = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::EventSourceMapping"))
        .filter((mapping) => JSON.stringify(mapping.Properties.EventSourceArn) === JSON.stringify(queueArn));
      expect(mappings).toHaveLength(1);
      expect(mappings[0].Properties).toEqual(expect.objectContaining({
        BatchSize: 1,
        Enabled: true,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        ScalingConfig: { MaximumConcurrency: 2 },
      }));
      expect(JSON.stringify(mappings[0].Properties.FunctionName)).toMatch(/RestampUserVotesProdAlias[^"]*"\}\]\}\]\},":prod"/);
      const sqsActions = statementsOf("RestampUserVotes").filter((statement) => actionsOf(statement).some((action) => action.startsWith("sqs:")));
      expect(sqsActions).toEqual([expect.objectContaining({ Resource: queueArn })]);
      expect(actionsOf(sqsActions[0])).not.toContain("sqs:SendMessage");
    });

    test("DistrictVerification gets the claims table, the limits mode and the re-stamp queue", () => {
      expect(environmentOf("DistrictVerification")).toEqual(expect.objectContaining({
        ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
        VERIFICATION_LIMITS_MODE,
        VOTE_RESTAMP_QUEUE_URL: { Ref: queueId("RestampUserVotesQueue") },
        // Unchanged: the IP lookup stays off (question Q2), so the INT-02 flag stays "unknown".
      }));
      expect(environmentOf("DistrictVerification").IP_LOOKUP_ENABLED).toBeUndefined();
      const access = storeActions(statementsOf("DistrictVerification"));
      expect(Object.keys(access)).toEqual(["table/UserPII", "table/VerifiedAddressClaims"]);
      expect(access["table/VerifiedAddressClaims"]).toEqual([
        "dynamodb:BatchGetItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ]);
      const sends = statementsOf("DistrictVerification").filter((statement) => actionsOf(statement).includes("sqs:SendMessage"));
      expect(sends).toEqual([expect.objectContaining({ Resource: { "Fn::GetAtt": [queueId("RestampUserVotesQueue"), "Arn"] } })]);
    });

    test("only DistrictVerification and the account deletion may write the address claims, and only DistrictVerification may send re-stamp messages", () => {
      const policiesNaming = (needle: string) => Object.values(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
        .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(needle))
        .flatMap((policy) => policy.Properties.Roles.map((role: { Ref: string }) => role.Ref.replace(/ServiceRole[0-9A-F]{8}$/, "")))
        .sort();
      // Account deletion releases the claim (X5 (a)); CleanupOrphanedUsers only reads it (X23).
      expect(policiesNaming("table/VerifiedAddressClaims")).toEqual(["AccountData", "CleanupOrphanedUsers", "DistrictVerification"]);
      const claimWriters = ["AccountData", "CleanupOrphanedUsers", "DistrictVerification"]
        .filter((functionName) => (storeActions(statementsOf(functionName))["table/VerifiedAddressClaims"] ?? []).some(isDataWrite));
      expect(claimWriters).toEqual(["AccountData", "DistrictVerification"]);
      expect(policiesNaming(queueId("RestampUserVotesQueue"))).toEqual(["DistrictVerification", "RestampUserVotes"]);
    });
  });

  describe("UX-31: the Civic Score record and the first-vote time", () => {
    test("FetchCivicScore may GetItem and UpdateItem UserPII (its record) and only read UserFeedback", () => {
      expect(environmentOf("FetchCivicScore")).toEqual(
        expect.objectContaining({ PII_TABLE_NAME: "UserPII", PII_PARTITION_KEY: "userId", TABLE_NAME: "UserFeedback" }),
      );
      const access = storeActions(statementsOf("FetchCivicScore"));
      expect(access["table/UserPII"]).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
      expect(access["table/UserFeedback"].filter(isDataWrite)).toEqual([]);
      expect(Object.keys(access)).toEqual([
        "table/BillsManifest",
        "table/UserFeedback",
        "table/UserFeedback/index/*",
        "table/UserPII",
      ]);
    });

    test("SetFeedback may GetItem the caller's earlier vote on UserFeedback, besides writing it", () => {
      const access = storeActions(statementsOf("SetFeedback"));
      expect(access["table/UserFeedback"]).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem"]));
      expect(access["table/UserFeedback"].filter((action) => !isDataWrite(action))).toEqual([
        "dynamodb:DescribeTable",
        "dynamodb:GetItem",
      ]);
    });
  });

  describe("INT-06: SetFeedback", () => {
    test("runs the daily cap in VOTE_DAILY_CAP_MODE and may UpdateItem UserPII for the counter, nothing else written there", () => {
      expect(environmentOf("SetFeedback")).toEqual(expect.objectContaining({ VOTE_DAILY_CAP_MODE }));
      const access = storeActions(statementsOf("SetFeedback"));
      expect(access["table/UserPII"].filter(isDataWrite)).toEqual(["dynamodb:UpdateItem"]);
      expect(access["table/UserPII"]).toEqual(expect.arrayContaining(["dynamodb:GetItem"]));
      expect(Object.keys(access)).toEqual([
        "table/AppAttest",
        "table/BillsManifest",
        "table/UserFeedback",
        "table/UserFeedback/index/*",
        "table/UserPII",
      ]);
    });
  });

  describe("7B: the web ACL's sign-up rule alarm", () => {
    test("alarms on the rule's counted plus blocked requests over an hour, on the routine alarm topic", () => {
      const alarms = Object.values(templates.userApiTemplate.findResources("AWS::CloudWatch::Alarm", {
        Properties: { AlarmName: COGNITO_SIGN_UP_RATE_LIMITED_ALARM_NAME },
      }));
      expect(alarms).toHaveLength(1);
      const properties = alarms[0].Properties;
      expect(properties).toEqual(expect.objectContaining({
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        Threshold: 1,
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
      }));
      expect(properties.AlarmDescription.length).toBeLessThanOrEqual(1024);
      // The topic MonitoringStack owns, resolved by name (alarmTopicFromName): the routine tier, never the page topic.
      expect(JSON.stringify(properties.AlarmActions)).toMatch(/:sns:.*:BillboardAlarmTopic"/);
      const webAclName = { "Fn::Select": [0, { "Fn::Split": ["|", { Ref: "UserApiWebAcl" }] }] };
      const metric = (id: string, metricName: string) => ({
        Id: id,
        ReturnData: false,
        MetricStat: {
          Metric: {
            Namespace: "AWS/WAFV2",
            MetricName: metricName,
            Dimensions: [
              { Name: "Region", Value: { Ref: "AWS::Region" } },
              { Name: "Rule", Value: "CognitoSignUpRateLimit" },
              { Name: "WebACL", Value: webAclName },
            ],
          },
          Period: 3600,
          Stat: "Sum",
        },
      });
      expect(properties.Metrics).toEqual([
        expect.objectContaining({ Expression: "SUM([counted, blocked])", ReturnData: true }),
        metric("counted", "CountedRequests"),
        metric("blocked", "BlockedRequests"),
      ]);
    });

    test("the gateway construct follows the action it is given: count or block", () => {
      const ruleAction = (signUpRateLimitAction: "count" | "block") => {
        const stack = new cdk.Stack(new cdk.App(), "GatewayOnly");
        const userPool = new cognito.UserPool(stack, "Pool");
        const gateway = new UserApiGateway(stack, "Gateway", { userPool, signUpRateLimitAction });
        // An authorizer must be attached to a method before the stack synthesizes.
        gateway.addCognitoMethod(gateway.api.root, "GET", new lambda.Function(stack, "Handler", {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "index.handler",
          code: lambda.Code.fromInline("exports.handler = async () => ({})"),
        }));
        const acl = Object.values(Template.fromStack(stack).findResources("AWS::WAFv2::WebACL"))[0];
        return Object.fromEntries((acl.Properties.Rules as Array<Record<string, any>>).map((rule) => [rule.Name, rule.Action]));
      };
      expect(ruleAction("count")).toEqual({ UserApiRateLimitRule: { Block: {} }, CognitoSignUpRateLimit: { Count: {} } });
      expect(ruleAction("block")).toEqual({ UserApiRateLimitRule: { Block: {} }, CognitoSignUpRateLimit: { Block: {} } });
    });
  });

  // The two kinds of change section 6 allows: the emergency kill switch, and the flip PR. Each synthesizes
  // the stack again with the constants changed and compares it with the shipped template.
  describe("switch flips", () => {
    test("PRE_SIGN_UP_TRIGGER_ENABLED=false detaches the trigger and changes nothing else", () => {
      const flipped = synthUserApiWithAbuseLimits({ PRE_SIGN_UP_TRIGGER_ENABLED: false });
      const changes = templateChanges(template(), flipped);
      expect(changes).toEqual({
        added: [],
        removed: [expect.stringMatching(/^BillboardUserPoolPreSignUpCognito[0-9A-F]{8}$/)],
        changed: [userPoolId()],
      });
      // Back to the pool without its trigger, byte for byte: LambdaConfig is gone, not emptied.
      expect(flipped.Resources[userPoolId()].Properties).toEqual(USER_POOL_PROPERTIES_WITHOUT_TRIGGER);
      // The function, its alias, deployment group and alarms stay, ready to be attached again.
      expect(Object.keys(flipped.Resources)).toEqual(expect.arrayContaining([
        functionNamed("PreSignUpCheck")[0],
        aliasId("PreSignUpCheck"),
        logicalIdOf("AWS::CodeDeploy::DeploymentGroup", "PreSignUpCheckDeploymentGroup"),
      ]));
    });

    // The filter check expects the filter's mode, so SIGNUP_FILTER_MODE also reaches SignUpFilterCheck, under its own
    // name SIGNUP_FILTER_CHECK_EXPECTED_MODE (CB-07).
    test("the flip PR's values change exactly the four functions' modes, the filter check's expected mode and the sign-up rule's action", () => {
      const flipped = synthUserApiWithAbuseLimits({
        VOTE_DAILY_CAP_MODE: "enforce",
        VERIFICATION_LIMITS_MODE: "enforce",
        VOTE_RESTAMP_MODE: "apply",
        SIGNUP_FILTER_MODE: "enforce",
        SIGNUP_RATE_LIMIT_ACTION: "block",
      });
      const fnId = (functionName: string) => functionNamed(functionName)[0];
      expect(templateChanges(template(), flipped)).toEqual({
        added: [],
        removed: [],
        changed: [
          fnId("DistrictVerification"),
          fnId("PreSignUpCheck"),
          fnId("RestampUserVotes"),
          fnId("SetFeedback"),
          fnId("SignUpFilterCheck"),
          "UserApiWebAcl",
        ].sort(),
      });
      const flippedEnvironment = (functionName: string) => flipped.Resources[fnId(functionName)].Properties.Environment.Variables;
      expect(flippedEnvironment("SetFeedback")).toEqual({ ...environmentOf("SetFeedback"), VOTE_DAILY_CAP_MODE: "enforce" });
      expect(flippedEnvironment("DistrictVerification")).toEqual({ ...environmentOf("DistrictVerification"), VERIFICATION_LIMITS_MODE: "enforce" });
      expect(flippedEnvironment("RestampUserVotes")).toEqual({ ...environmentOf("RestampUserVotes"), VOTE_RESTAMP_MODE: "apply" });
      expect(flippedEnvironment("PreSignUpCheck")).toEqual({ ...environmentOf("PreSignUpCheck"), SIGNUP_FILTER_MODE: "enforce" });
      expect(flippedEnvironment("SignUpFilterCheck")).toEqual({
        ...environmentOf("SignUpFilterCheck"),
        SIGNUP_FILTER_CHECK_EXPECTED_MODE: "enforce",
      });
      const rules = flipped.Resources.UserApiWebAcl.Properties.Rules as Array<Record<string, any>>;
      const shippedRules = template().Resources.UserApiWebAcl.Properties.Rules as Array<Record<string, any>>;
      expect(rules).toEqual([shippedRules[0], { ...shippedRules[1], Action: { Block: {} } }]);
    });
  });

  // ── CB-07: the sign-up filter check ──────────────────────────────────────────────────────────────────
  describe("CB-07: SignUpFilterCheck", () => {
    test("the check address is a plain lower-case address on the project's own domain", () => {
      expect(SIGNUP_FILTER_CHECK_ADDRESS).toMatch(/^[a-z0-9._-]+@billboard-project\.com$/);
    });

    test("is a release-backed worker: 256 MB, 60 s, the switch, the address, the expected mode, the pool, the app client and the table", () => {
      const [, fn] = functionNamed("SignUpFilterCheck");
      expect(fn.Properties).toEqual(expect.objectContaining({
        Handler: "dist/index.handler",
        Runtime: "nodejs24.x",
        MemorySize: 256,
        Timeout: 60,
      }));
      // No salt: the email key comes from the account's USER# item. One secret, the probe token (INF-15).
      expect(environmentOf("SignUpFilterCheck")).toEqual({
        SIGNUP_FILTER_CHECK_ENABLED,
        SIGNUP_FILTER_CHECK_ADDRESS,
        SIGNUP_FILTER_CHECK_EXPECTED_MODE: SIGNUP_FILTER_MODE,
        USER_POOL_ID: { Ref: userPoolId() },
        USER_POOL_CLIENT_ID: { Ref: "BillboardUserPoolUserPoolClient61DEF7CD" },
        SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
        SIGNUP_PROBE_TOKEN_SECRET_ARN: { Ref: probeTokenSecretId() },
      });
      expect(deploymentGroupOf("SignUpFilterCheck").Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaAllAtOnce");
    });

    test("runs one at a time (reserved concurrency 1), so two runs never overlap", () => {
      expect(SIGNUP_FILTER_CHECK_RESERVED_CONCURRENCY).toBe(1);
      expect(functionNamed("SignUpFilterCheck")[1].Properties.ReservedConcurrentExecutions).toBe(1);
    });

    test("may ListUsers, AdminGetUser and AdminDeleteUser on the pool, GetItem and DeleteItem the claims table, and read the probe token, nothing more", () => {
      const statements = statementsOf("SignUpFilterCheck");
      expect(storeActions(statements)).toEqual({ "table/SignUpEmailClaims": ["dynamodb:DeleteItem", "dynamodb:GetItem"] });
      const cognitoStatements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("cognito-idp:")));
      expect(cognitoStatements).toEqual([{
        Action: ["cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser", "cognito-idp:ListUsers"],
        Effect: "Allow",
        Resource: { "Fn::GetAtt": [userPoolId(), "Arn"] },
      }]);
      const secretStatements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("secretsmanager:")));
      expect(secretStatements.map((statement) => ({ actions: actionsOf(statement).sort(), resource: statement.Resource }))).toEqual([
        { actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], resource: { Ref: probeTokenSecretId() } },
      ]);
      const actions = statements.flatMap(actionsOf);
      expect(actions.filter((action) => /^(sqs|sns|s3|kms|cloudwatch|logs:FilterLogEvents)/.test(action))).toEqual([]);
      expect(actions.filter((action) => /^dynamodb:(PutItem|UpdateItem|Scan|Query|BatchWriteItem|\*)$/.test(action))).toEqual([]);
      expect(JSON.stringify(statements)).not.toContain("DistrictVerificationHashSalt");
    });

    test("runs daily at 11:30 UTC through its prod alias, with the failure queue, and is never retried", () => {
      const aliasRef = { Ref: Match.stringLikeRegexp("^SignUpFilterCheckProdAlias") };
      templates.userApiTemplate.hasResourceProperties("AWS::Events::Rule", {
        ScheduleExpression: "cron(30 11 * * ? *)",
        State: "ENABLED",
        Targets: [Match.objectLike({ Arn: aliasRef, DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }) })],
      });
      templates.userApiTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
        FunctionName: { Ref: Match.stringLikeRegexp("^SignUpFilterCheck") },
        MaximumRetryAttempts: 0,
        DestinationConfig: Match.absent(),
      });
    });

    test("the pool does not depend on it (no dependency cycle) and nothing else about the pool changes", () => {
      expect(dependencyCycles(template())).toEqual([]);
      expect(JSON.stringify(templates.userApiTemplate.findResources("AWS::Cognito::UserPool"))).not.toContain("SignUpFilterCheck");
    });

    test("flipping SIGNUP_FILTER_CHECK_ENABLED changes SignUpFilterCheck's switch and nothing else", () => {
      const other = SIGNUP_FILTER_CHECK_ENABLED === "true" ? "false" : "true";
      const flipped = synthUserApiWithAbuseLimits({ SIGNUP_FILTER_CHECK_ENABLED: other });
      const fnId = functionNamed("SignUpFilterCheck")[0];
      expect(templateChanges(template(), flipped)).toEqual({ added: [], removed: [], changed: [fnId] });
      expect(flipped.Resources[fnId].Properties.Environment.Variables).toEqual({
        ...environmentOf("SignUpFilterCheck"),
        SIGNUP_FILTER_CHECK_ENABLED: other,
      });
    });

    test("the services read every variable it is given", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "..", "services", "src", "handlers", "signUpFilterCheck", "index.ts"), "utf8");
      Object.keys(environmentOf("SignUpFilterCheck"))
        .filter((name) => name !== "SIGNUP_FILTER_CHECK_ADDRESS")
        .forEach((name) => expect(source).toContain(`env.${name}`));
      const shared = fs.readFileSync(path.join(__dirname, "..", "..", "services", "src", "shared", "signUpFilter.ts"), "utf8");
      expect(shared).toContain("env.SIGNUP_FILTER_CHECK_ADDRESS");
    });
  });

  // ── INT-04: App Attest (C3 WP-C3d and 7.2, with the integration plan's X2, X5 and X23) ───────────────
  describe("INT-04: App Attest", () => {
    const appAttestVariables = (functionName: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(environmentOf(functionName))
        .filter(([name]) => /^(APP_ATTEST_|DEVICE_|MIN_APP_VERSION$)/.test(name)));
    const apiResources = () => templates.userApiTemplate.findResources("AWS::ApiGateway::Resource");
    // "/a/b" for an API Gateway resource, walking ParentId up to the API root.
    const pathOfResource = (logicalId: string): string => {
      const resource = apiResources()[logicalId];
      const parent = resource.Properties.ParentId?.Ref as string | undefined;
      return `${parent ? pathOfResource(parent) : ""}/${resource.Properties.PathPart}`;
    };
    const methodsOn = (resourcePath: string) =>
      Object.values(templates.userApiTemplate.findResources("AWS::ApiGateway::Method"))
        .filter((method) => method.Properties.ResourceId?.Ref && pathOfResource(method.Properties.ResourceId.Ref) === resourcePath)
        .map((method) => method.Properties);
    const stageMethodSettings = (stageTemplate: CfnTemplate = template()): Array<Record<string, any>> => {
      const stages = Object.values(stageTemplate.Resources).filter((resource) => resource.Type === "AWS::ApiGateway::Stage");
      expect(stages).toHaveLength(1);
      return stages[0].Properties.MethodSettings;
    };
    const serviceSource = (...segments: string[]): string =>
      fs.readFileSync(path.join(__dirname, "..", "..", "services", ...segments), "utf8");

    test("AppAttest is a release-backed API handler: 256 MB, 10 s, its reserved concurrency, the 10-minute canary", () => {
      const [, fn] = functionNamed("AppAttest");
      expect(fn.Properties).toEqual(expect.objectContaining({
        Handler: "dist/index.handler",
        Runtime: "nodejs24.x",
        MemorySize: 256,
        Timeout: 10,
        ReservedConcurrentExecutions: APP_ATTEST_RESERVED_CONCURRENCY,
        TracingConfig: { Mode: "Active" },
      }));
      // The release artifact is the services handler folder of the same name.
      expect(fn.Properties.Code.S3Key).toBe("appAttest.zip");
      expect(fs.existsSync(path.join(__dirname, "..", "..", "services", "src", "handlers", "appAttest", "index.ts"))).toBe(true);
      const group = deploymentGroupOf("AppAttest");
      expect(group.Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaCanary10Percent10Minutes");
      // Its own alias error alarm, the API 5XX alarm and the canary alarm.
      expect(group.Properties.AlarmConfiguration.Alarms).toHaveLength(3);
    });

    test("AppAttest runs with its client mode, the table and the challenge lifetime, and may only GetItem, PutItem and UpdateItem it", () => {
      expect(environmentOf("AppAttest")).toEqual({
        APP_ATTEST_TABLE_NAME: "AppAttest",
        APP_ATTEST_CLIENT_MODE,
        APP_ATTEST_CHALLENGE_TTL_SECONDS: String(APP_ATTEST_CHALLENGE_TTL_SECONDS),
      });
      const statements = statementsOf("AppAttest");
      expect(storeActions(statements)).toEqual({
        "table/AppAttest": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      });
      // Nothing else: X-Ray only (no Scan, no delete, no secret, queue, Cognito or metric grant; EMF needs none).
      expect(statements.flatMap(actionsOf).filter((action) => !action.startsWith("xray:")).sort()).toEqual([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]);
    });

    // X2: the routes the OpenAPI document gains in the same change (contracts npm run check: 28 routes).
    test("POST /app-attest/challenge and POST /app-attest/attest are public: no authorizer, no API key, the AppAttest prod alias", () => {
      ["/app-attest/challenge", "/app-attest/attest"].forEach((resourcePath) => {
        const methods = methodsOn(resourcePath);
        expect({ resourcePath, methods: methods.map((method) => method.HttpMethod) }).toEqual({ resourcePath, methods: ["POST"] });
        const [method] = methods;
        expect(method.AuthorizationType).toBe("NONE");
        expect(method.AuthorizerId).toBeUndefined();
        expect(method.ApiKeyRequired).not.toBe(true);
        expect(method.Integration.Type).toBe("AWS_PROXY");
        expect(JSON.stringify(method.Integration.Uri)).toMatch(/"Ref":"AppAttestProdAlias[0-9A-F]{8}"/);
      });
      // /app-attest itself has no method.
      expect(methodsOn("/app-attest")).toEqual([]);
    });

    test("the OpenAPI document has both routes with security [] and the AppAttest handler (X2)", () => {
      const openApi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "contracts", "openapi", "user-api.v1.json"), "utf8"));
      ["/app-attest/challenge", "/app-attest/attest"].forEach((route) => {
        const operation = openApi.paths[route]?.post;
        expect({ route, security: operation?.security, handler: operation?.["x-billboard-handler"] }).toEqual({
          route,
          security: [],
          handler: "services/src/handlers/appAttest",
        });
        expect(Object.keys(openApi.paths[route])).toEqual(["post"]);
      });
    });

    // API Gateway answers a Lambda throttle with a 500, which would reach Billboard-API-5XXError (a page) and the
    // API groups' rollback alarm. These method throttles refuse the excess with a 429 before the function.
    test("each App Attest method has its own stage throttle, within the reserved concurrency, written as CDK writes method options", () => {
      const reference = new cdk.Stack(new cdk.App(), "MethodOptionsEncoding");
      const referenceApi = new apigateway.RestApi(reference, "Api", {
        deployOptions: { methodOptions: { "/app-attest/challenge/POST": { throttlingRateLimit: 1 } } },
      });
      referenceApi.root.addMethod("GET");
      const [referenceStage] = Object.values(Template.fromStack(reference).findResources("AWS::ApiGateway::Stage"));
      const challengePath = referenceStage.Properties.MethodSettings[0].ResourcePath;
      expect(challengePath).toBe("/~1app-attest~1challenge");

      const settings = stageMethodSettings();
      const [stageWide] = settings;
      expect(stageWide).toEqual(expect.objectContaining({
        ResourcePath: "/*",
        HttpMethod: "*",
        ThrottlingRateLimit: USER_API_STAGE_THROTTLE.rateLimit,
        ThrottlingBurstLimit: USER_API_STAGE_THROTTLE.burstLimit,
      }));
      const inherited = { LoggingLevel: stageWide.LoggingLevel, MetricsEnabled: stageWide.MetricsEnabled, DataTraceEnabled: stageWide.DataTraceEnabled };
      const throttled = (throttle: { rateLimit: number; burstLimit: number }) => ({
        ThrottlingRateLimit: throttle.rateLimit,
        ThrottlingBurstLimit: throttle.burstLimit,
      });
      expect(settings.slice(1)).toEqual([
        { ResourcePath: challengePath, HttpMethod: "POST", ...inherited, ...throttled(APP_ATTEST_CHALLENGE_THROTTLE) },
        { ResourcePath: "/~1app-attest~1attest", HttpMethod: "POST", ...inherited, ...throttled(APP_ATTEST_ATTEST_THROTTLE) },
      ]);
      expect(inherited).toEqual({ LoggingLevel: "ERROR", MetricsEnabled: true, DataTraceEnabled: false });
      // The bursts fit the reserved concurrency, and the rates do for calls of up to 400 ms.
      const throttles = [APP_ATTEST_CHALLENGE_THROTTLE, APP_ATTEST_ATTEST_THROTTLE];
      expect(throttles.reduce((sum, throttle) => sum + throttle.burstLimit, 0)).toBeLessThanOrEqual(APP_ATTEST_RESERVED_CONCURRENCY);
      expect(throttles.reduce((sum, throttle) => sum + throttle.rateLimit, 0) * 0.4).toBeLessThanOrEqual(APP_ATTEST_RESERVED_CONCURRENCY);
    });

    test("SetFeedback checks votes in APP_ATTEST_VOTE_MODE with the exempt group, and may GetItem, PutItem and UpdateItem the table", () => {
      expect(appAttestVariables("SetFeedback")).toEqual({
        APP_ATTEST_MODE: APP_ATTEST_VOTE_MODE,
        APP_ATTEST_TABLE_NAME: "AppAttest",
        APP_ATTEST_ALLOWED_ENVIRONMENTS,
        APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(APP_ATTEST_MAX_ACCOUNTS_PER_KEY),
        APP_ATTEST_FAIL_CLOSED: String(APP_ATTEST_FAIL_CLOSED),
        APP_ATTEST_EXEMPT_GROUP,
        ...(MIN_APP_VERSION ? { MIN_APP_VERSION } : {}),
      });
      // Empty MIN_APP_VERSION is left out (unset and empty mean the same to the handler).
      expect(environmentOf("SetFeedback").MIN_APP_VERSION).toBe(MIN_APP_VERSION || undefined);
      expect(storeActions(statementsOf("SetFeedback"))["table/AppAttest"]).toEqual([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]);
    });

    test("PreSignUpCheck checks sign-ups in APP_ATTEST_SIGN_UP_MODE and DEVICE_CHECK_MODE, and its default policy still names no pool", () => {
      expect(appAttestVariables("PreSignUpCheck")).toEqual({
        APP_ATTEST_MODE: APP_ATTEST_SIGN_UP_MODE,
        APP_ATTEST_TABLE_NAME: "AppAttest",
        APP_ATTEST_ALLOWED_ENVIRONMENTS,
        APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(APP_ATTEST_MAX_ACCOUNTS_PER_KEY),
        APP_ATTEST_FAIL_CLOSED: String(APP_ATTEST_FAIL_CLOSED),
        DEVICE_CHECK_MODE,
        DEVICE_CHECK_SECRET_NAME: "Billboard/AppleDeviceCheckKey",
        DEVICE_MAX_ACCOUNTS: String(DEVICE_MAX_ACCOUNTS),
        DEVICE_COUNTER_WINDOW_MONTHS: String(DEVICE_COUNTER_WINDOW_MONTHS),
        ...(MIN_APP_VERSION ? { MIN_APP_VERSION } : {}),
      });
      // Votes only: the exempt group never applies to sign-up (only admin-created users are exempt there).
      expect(environmentOf("PreSignUpCheck").APP_ATTEST_EXEMPT_GROUP).toBeUndefined();
      const defaultPolicy = Object.entries(templates.userApiTemplate.findResources("AWS::IAM::Policy"))
        .find(([id]) => /^PreSignUpCheckServiceRoleDefaultPolicy/.test(id))!;
      expect(JSON.stringify(defaultPolicy[1])).not.toContain(userPoolId());
    });

    test("every App Attest variable the stack sets is one the services read, and nothing else sets them", () => {
      const config = serviceSource("src", "shared", "appAttest", "config.ts");
      const names = new Set(["SetFeedback", "PreSignUpCheck", "AppAttest"].flatMap((functionName) =>
        Object.keys(appAttestVariables(functionName))));
      // MIN_APP_VERSION only while it is set.
      expect(names.size).toBe(MIN_APP_VERSION ? 13 : 12);
      names.forEach((name) => expect({ name, read: config.includes(`env.${name}`) }).toEqual({ name, read: true }));
      // Only the three App Attest functions and the two account deleters (APP_ATTEST_TABLE_NAME, X5) carry any.
      const holders = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function"))
        .filter((fn) => Object.keys(fn.Properties.Environment?.Variables ?? {}).some((name) => /^(APP_ATTEST_|DEVICE_CHECK|DEVICE_MAX|DEVICE_COUNTER|MIN_APP_VERSION$)/.test(name)))
        .map((fn) => fn.Properties.FunctionName)
        .sort();
      expect(holders).toEqual(["AccountData", "AppAttest", "CleanupOrphanedUsers", "PreSignUpCheck", "SetFeedback"]);
    });

    test("the exempt group exists, empty, on the pool, and the pool and its clients keep their logical IDs", () => {
      const groups = templates.userApiTemplate.findResources("AWS::Cognito::UserPoolGroup");
      expect(Object.keys(groups)).toEqual(["AppAttestExemptGroup"]);
      expect(groups.AppAttestExemptGroup.Properties).toEqual({
        GroupName: APP_ATTEST_EXEMPT_GROUP,
        UserPoolId: { Ref: userPoolId() },
        Description: expect.stringMatching(/never blocked/),
      });
      // Members are added by hand (a C3 setup step), never by the stack.
      templates.userApiTemplate.resourceCountIs("AWS::Cognito::UserPoolUserToGroupAttachment", 0);
      expect(userPoolId()).toBe("BillboardUserPoolC41FE3DD");
      expect(Object.keys(templates.userApiTemplate.findResources("AWS::Cognito::UserPoolClient")).sort()).toEqual([
        "BillboardUserPoolBillboardCanaryClient2EACA7EB",
        "BillboardUserPoolUserPoolClient61DEF7CD",
      ]);
    });

    // X5: the account deletion's three steps, each skipped while its variable is unset; X23: Cleanup reads only.
    test("AccountData and CleanupOrphanedUsers get the three table variables, with the names the other consumers read", () => {
      const tableVariables = {
        ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
        SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
        APP_ATTEST_TABLE_NAME: "AppAttest",
      };
      ["AccountData", "CleanupOrphanedUsers"].forEach((functionName) =>
        expect({ functionName, environment: environmentOf(functionName) })
          .toEqual({ functionName, environment: expect.objectContaining(tableVariables) }));
      expect(environmentOf("CleanupOrphanedUsers").DRY_RUN).toBe("true");
      expect(serviceSource("src", "handlers", "districtVerification", "index.ts")).toContain("process.env.ADDRESS_CLAIMS_TABLE_NAME");
      expect(serviceSource("src", "handlers", "preSignUp", "index.ts")).toContain("process.env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME");
      expect(serviceSource("src", "shared", "appAttest", "config.ts")).toContain("env.APP_ATTEST_TABLE_NAME");
    });

    test("AccountData may release the address claim, delete the email claim and delete the App Attest bindings", () => {
      const access = storeActions(statementsOf("AccountData"));
      expect({
        claims: access["table/VerifiedAddressClaims"],
        email: access["table/SignUpEmailClaims"],
        appAttest: access["table/AppAttest"],
      }).toEqual({
        // Only what deleteUserData sends: no GetItem on the claims (only the cleanup dry run reads them) and
        // no DeleteItem on AppAttest (the bindings go in BatchWriteItem).
        claims: ["dynamodb:DeleteItem", "dynamodb:UpdateItem"],
        email: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
        appAttest: ["dynamodb:BatchWriteItem", "dynamodb:Query"],
      });
    });

    // REL-53: plus DeleteItem on SignUpEmailClaims while UNCONFIRMED_SIGNUP_CLEANUP_MODE is 'delete'.
    test("CleanupOrphanedUsers may only GetItem and Query the three tables while its dry run holds (X23)", () => {
      const access = storeActions(statementsOf("CleanupOrphanedUsers"));
      ["table/VerifiedAddressClaims", "table/SignUpEmailClaims", "table/AppAttest"].forEach((table) =>
        expect({ table, actions: access[table] }).toEqual({
          table,
          actions: [
            ...(table === "table/SignUpEmailClaims" && UNCONFIRMED_SIGNUP_CLEANUP_MODE === "delete" ? ["dynamodb:DeleteItem"] : []),
            "dynamodb:GetItem",
            "dynamodb:Query",
          ],
        }));
    });

    test("only the App Attest functions and AccountData write the AppAttest table, and nothing scans it", () => {
      const access = (functionName: string) => storeActions(statementsOf(functionName))["table/AppAttest"] ?? [];
      const functionNames = Object.values(templates.userApiTemplate.findResources("AWS::Lambda::Function"))
        .map((fn) => fn.Properties.FunctionName)
        .filter((name): name is string => typeof name === "string");
      const writers = functionNames.filter((name) => access(name).some(isDataWrite)).sort();
      expect(writers).toEqual(["AccountData", "AppAttest", "PreSignUpCheck", "SetFeedback"]);
      const readers = functionNames.filter((name) => access(name).length > 0).sort();
      expect(readers).toEqual(["AccountData", "AppAttest", "CleanupOrphanedUsers", "PreSignUpCheck", "SetFeedback"]);
      functionNames.forEach((name) => expect({ name, scan: access(name).includes("dynamodb:Scan") }).toEqual({ name, scan: false }));
    });

    // The flips C3 section 8 describes, each a constant change plus a deploy. Each changes exactly its functions.
    describe("App Attest switch flips", () => {
      const fnId = (functionName: string) => functionNamed(functionName)[0];
      const flippedVariables = (flipped: CfnTemplate, functionName: string) =>
        flipped.Resources[fnId(functionName)].Properties.Environment.Variables;

      test("votes to enforce changes SetFeedback's APP_ATTEST_MODE and nothing else", () => {
        const flipped = synthUserApiWithAbuseLimits({ APP_ATTEST_VOTE_MODE: "enforce" });
        expect(templateChanges(template(), flipped)).toEqual({ added: [], removed: [], changed: [fnId("SetFeedback")] });
        expect(flippedVariables(flipped, "SetFeedback")).toEqual({ ...environmentOf("SetFeedback"), APP_ATTEST_MODE: "enforce" });
      });

      test("sign-up to enforce and DeviceCheck to watch change PreSignUpCheck only", () => {
        const flipped = synthUserApiWithAbuseLimits({ APP_ATTEST_SIGN_UP_MODE: "enforce", DEVICE_CHECK_MODE: "watch" });
        expect(templateChanges(template(), flipped)).toEqual({ added: [], removed: [], changed: [fnId("PreSignUpCheck")] });
        expect(flippedVariables(flipped, "PreSignUpCheck")).toEqual({
          ...environmentOf("PreSignUpCheck"),
          APP_ATTEST_MODE: "enforce",
          DEVICE_CHECK_MODE: "watch",
        });
      });

      test("the R2 kill switch APP_ATTEST_CLIENT_MODE=off changes the AppAttest function only", () => {
        const flipped = synthUserApiWithAbuseLimits({ APP_ATTEST_CLIENT_MODE: "off" });
        expect(templateChanges(template(), flipped)).toEqual({ added: [], removed: [], changed: [fnId("AppAttest")] });
        expect(flippedVariables(flipped, "AppAttest")).toEqual({ ...environmentOf("AppAttest"), APP_ATTEST_CLIENT_MODE: "off" });
      });

      test("fail-closed and a minimum version reach SetFeedback and PreSignUpCheck only", () => {
        const flipped = synthUserApiWithAbuseLimits({ APP_ATTEST_FAIL_CLOSED: true, MIN_APP_VERSION: "1.2" });
        expect(templateChanges(template(), flipped)).toEqual({
          added: [],
          removed: [],
          changed: [fnId("PreSignUpCheck"), fnId("SetFeedback")].sort(),
        });
        ["SetFeedback", "PreSignUpCheck"].forEach((functionName) =>
          expect(flippedVariables(flipped, functionName)).toEqual({
            ...environmentOf(functionName),
            APP_ATTEST_FAIL_CLOSED: "true",
            MIN_APP_VERSION: "1.2",
          }));
      });

      test("synth refuses a minimum version the handlers could not parse", () => {
        expect(() => synthUserApiWithAbuseLimits({ MIN_APP_VERSION: "1.2-beta" })).toThrow(/MIN_APP_VERSION "1.2-beta"/);
        expect(() => synthUserApiWithAbuseLimits({ MIN_APP_VERSION: "1.2.3.4" })).toThrow(/MIN_APP_VERSION/);
      });

      test("raising the route throttles changes only the stage", () => {
        const flipped = synthUserApiWithAbuseLimits({
          APP_ATTEST_CHALLENGE_THROTTLE: { rateLimit: 20, burstLimit: 4 },
        });
        const stageId = Object.keys(templates.userApiTemplate.findResources("AWS::ApiGateway::Stage"))[0];
        expect(templateChanges(template(), flipped)).toEqual({ added: [], removed: [], changed: [stageId] });
        expect(stageMethodSettings(flipped)[1]).toEqual(expect.objectContaining({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 4 }));
      });
    });
  });
});

// REL-53: CleanupOrphanedUsers deletes sign-ups left UNCONFIRMED for more than UNCONFIRMED_SIGNUP_MAX_AGE_HOURS,
// under its own switch. The flips compare with a 'dry_run' synth, not the shipped template, so they hold in either
// position (and prove the rollback from 'delete'). The IAM invariants elsewhere (security.test.ts, the D3 and X23
// tests above, data-store-grants.test.ts) follow the constant, so a change of position changes only the pin in
// abuse-limits.test.ts.
describe("CleanupOrphanedUsers: sign-ups left unconfirmed (REL-53)", () => {
  const shipped = (): CfnTemplate => templates.userApiTemplate.toJSON() as CfnTemplate;
  let dryRunTemplate: CfnTemplate | undefined;
  const dryRun = (): CfnTemplate =>
    (dryRunTemplate ??= UNCONFIRMED_SIGNUP_CLEANUP_MODE === "dry_run"
      ? shipped()
      : synthUserApiWithAbuseLimits({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "dry_run" }));
  const cleanupId = (template: CfnTemplate): string => {
    const ids = Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === "AWS::Lambda::Function" && resource.Properties.FunctionName === "CleanupOrphanedUsers")
      .map(([id]) => id);
    expect(ids).toHaveLength(1);
    return ids[0];
  };
  const environmentIn = (template: CfnTemplate): Record<string, unknown> =>
    template.Resources[cleanupId(template)].Properties.Environment.Variables;
  /** The cleanup role's statements in a template synthesized with other constants. */
  const statementsIn = (template: CfnTemplate): Array<Record<string, any>> => {
    const roleId: string = template.Resources[cleanupId(template)].Properties.Role["Fn::GetAtt"][0];
    return Object.values(template.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy")
      .filter((policy) => [policy.Properties.Roles].flat().some((role: { Ref?: string }) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  };
  const cognitoActionsIn = (template: CfnTemplate): string[] =>
    statementsIn(template)
      .flatMap((statement) => [statement.Action].flat() as string[])
      .filter((action) => action.startsWith("cognito-idp:"))
      .sort();

  test("gets its switch, the maximum age, the per-run cap and the probe address; dry_run adds no delete permission", () => {
    expect(environmentIn(shipped())).toEqual(expect.objectContaining({
      UNCONFIRMED_SIGNUP_CLEANUP_MODE,
      UNCONFIRMED_SIGNUP_MAX_AGE_HOURS: String(UNCONFIRMED_SIGNUP_MAX_AGE_HOURS),
      UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: String(UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN),
      SIGNUP_FILTER_CHECK_ADDRESS,
      // The orphan path's own switch is unchanged.
      DRY_RUN: "true",
    }));
    expect(cognitoActionsIn(dryRun())).toEqual(["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"]);
    expect(storeActions(statementsIn(dryRun()))["table/SignUpEmailClaims"]).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
  });

  test("'delete' adds exactly AdminDeleteUser on the pool and DeleteItem on SignUpEmailClaims, and changes nothing else", () => {
    const flipped = synthUserApiWithAbuseLimits({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });
    const policyIds = (template: CfnTemplate) =>
      Object.entries(template.Resources)
        .filter(([, resource]) => resource.Type === "AWS::IAM::Policy")
        .filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(template.Resources[cleanupId(template)].Properties.Role["Fn::GetAtt"][0]))
        .map(([id]) => id);
    expect(templateChanges(dryRun(), flipped)).toEqual({
      added: [],
      removed: [],
      changed: [cleanupId(dryRun()), ...policyIds(dryRun())].sort(),
    });
    expect(environmentIn(flipped)).toEqual({ ...environmentIn(dryRun()), UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });
    expect(cognitoActionsIn(flipped)).toEqual([
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
    ]);
    const deleteUser = statementsIn(flipped).filter((statement) => [statement.Action].flat().includes("cognito-idp:AdminDeleteUser"));
    expect(deleteUser).toHaveLength(1);
    expect(deleteUser[0].Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^BillboardUserPool/), "Arn"] });
    const access = storeActions(statementsIn(flipped));
    expect(access["table/SignUpEmailClaims"]).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:Query"]);
    // The two other account-integrity tables stay read-only (X23: their writes come with DRY_RUN=false).
    expect(access["table/VerifiedAddressClaims"]).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(access["table/AppAttest"]).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
  });

  test("'off' (the kill switch) changes only the variable", () => {
    const off = synthUserApiWithAbuseLimits({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "off" });
    expect(templateChanges(dryRun(), off)).toEqual({ added: [], removed: [], changed: [cleanupId(dryRun())] });
    expect(environmentIn(off)).toEqual({ ...environmentIn(dryRun()), UNCONFIRMED_SIGNUP_CLEANUP_MODE: "off" });
  });

  test("the handler reads the variables the stack sets", () => {
    const step = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "src", "handlers", "cleanupOrphanedUsers", "unconfirmedSignUps.ts"),
      "utf8",
    );
    [
      "env.UNCONFIRMED_SIGNUP_CLEANUP_MODE",
      '"UNCONFIRMED_SIGNUP_MAX_AGE_HOURS"',
      '"UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN"',
      "signUpFilterCheckAddress(",
    ].forEach((reference) => expect(step).toContain(reference));
    expect(step).toContain('export const UNCONFIRMED_CLEANUP_MODES = ["off", "dry_run", "delete"] as const;');
  });
});
