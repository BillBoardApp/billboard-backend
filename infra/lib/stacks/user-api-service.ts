import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import {
  SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
  USER_BILL_STATS_PARTITION_KEY,
  USER_BILL_STATS_TABLE_NAME,
  USER_DEVICES_SORT_KEY,
  USER_DEVICES_PUSH_TOKEN_INDEX,
  USER_DEVICES_TABLE_NAME,
  USER_FEEDBACK_BILL_ID_INDEX,
  USER_FEEDBACK_SORT_KEY,
  USER_FEEDBACK_TABLE_NAME,
  USER_PARTITION_KEY,
  USER_PII_TABLE_NAME,
  USER_PREFERENCES_SORT_KEY,
  USER_PREFERENCES_TABLE_NAME,
  USER_WEEKLY_DIGESTS_SORT_KEY,
  USER_WEEKLY_DIGESTS_TABLE_NAME,
  VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
} from '../config/user-store-constants';
import { BILL_STORE_BUCKET_NAME, BILLS_MANIFEST_TABLE_NAME, BILLS_MANIFEST_TABLE_PRIMARY_KEY, BILLS_MANIFEST_TABLE_SORT_KEY, BILLS_MANIFEST_TABLE_PK_VALUE, CONGRESS_MEMBER_STORE_BUCKET_NAME, CONGRESS_MEMBERS_MANIFEST_TABLE_NAME, CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY } from '../config/congress-store-constants';
import {
  CONGRESS_MEMBER_STATS_TABLE_NAME,
  CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY,
} from '../config/aggregate-data-store-constants';
import {
  BILL_PRIORITY_ACTIVE_INDEX_NAME,
  BILL_PRIORITY_ACTIVE_STATUS,
  BILL_PRIORITY_SORT_KEY_ATTRIBUTE,
  BILL_PRIORITY_STATUS_ATTRIBUTE,
  BILL_PRIORITY_TABLE_PARTITION_KEY,
} from '../config/priority-service-constants';
import {
  WEEKLY_DIGEST_CANONICAL_PUBLISH_DAY,
  WEEKLY_DIGEST_CANONICAL_PUBLISH_HOUR,
  WEEKLY_DIGEST_CANONICAL_PUBLISH_MINUTE,
  WEEKLY_DIGEST_CANONICAL_PUBLISH_TIMEZONE,
  WEEKLY_DIGEST_CANONICAL_SCHEDULE_EXPRESSION,
  WEEKLY_DIGEST_DLQ_MAX_RECEIVE_COUNT,
  WEEKLY_DIGEST_DLQ_RETENTION_DAYS,
  WEEKLY_DIGEST_METRIC_NAMESPACE,
  WEEKLY_DIGEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  WEEKLY_DIGEST_WORKER_BATCH_SIZE,
  WEEKLY_DIGEST_WORKER_MAX_CONCURRENCY,
  WEEKLY_DIGEST_WORKER_MEMORY_MB,
  WEEKLY_DIGEST_WORKER_TIMEOUT_SECONDS,
} from '../config/weekly-digest-constants';
import { APNS_PLATFORM_APPLICATION_NAME } from '../config/notification-service-constants';
import {
  ACCOUNT_EMAIL_FROM_ADDRESS,
  ACCOUNT_EMAIL_FROM_NAME,
  ACCOUNT_EMAIL_REPLY_TO,
  EMAIL_DOMAIN,
  SES_CONFIGURATION_SET_NAME,
  VERIFICATION_EMAIL_BODY,
  VERIFICATION_EMAIL_SUBJECT,
} from '../config/email-constants';
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  BILLS_MANIFEST_METRIC_NAMESPACE,
  BILLS_MANIFEST_SNAPSHOT_KEY,
  BILLS_MANIFEST_SNAPSHOT_SCHEDULE_EXPRESSION,
  BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_EVENT_AGE_SECONDS,
  BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_RETRY_ATTEMPTS,
  COGNITO_USER_EXPORT_PREFIX,
  COMPANION_GROUPS_ENABLED,
  PRE_SIGN_UP_CHECK_INTENTIONAL_ERROR_METRICS,
  PRE_SIGN_UP_CHECK_MEMORY_MB,
  PRE_SIGN_UP_CHECK_TIMEOUT_SECONDS,
  PUBLISH_BILLS_MANIFEST_MEMORY_MB,
  PUBLISH_BILLS_MANIFEST_TIMEOUT_SECONDS,
  RESTAMP_USER_VOTES_BATCH_SIZE,
  RESTAMP_USER_VOTES_DLQ_MAX_RECEIVE_COUNT,
  RESTAMP_USER_VOTES_DLQ_NAME,
  RESTAMP_USER_VOTES_DLQ_RETENTION_DAYS,
  RESTAMP_USER_VOTES_MAX_CONCURRENCY,
  RESTAMP_USER_VOTES_QUEUE_NAME,
  RESTAMP_USER_VOTES_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  RESTAMP_USER_VOTES_TIMEOUT_SECONDS,
  RETIRED_PROFILE_ATTRIBUTES_MODE,
  SIGNUP_FILTER_CHECK_MEMORY_MB,
  SIGNUP_FILTER_CHECK_RESERVED_CONCURRENCY,
  SIGNUP_FILTER_CHECK_SCHEDULE,
  SIGNUP_FILTER_CHECK_TIMEOUT_SECONDS,
  USER_API_DEFAULT_TIMEOUT_SECONDS,
  USER_API_NAME,
} from '../config/user-api-service-constants';
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
  PRE_SIGN_UP_TRIGGER_ENABLED,
  SIGNUP_FILTER_CHECK_ADDRESS,
  SIGNUP_FILTER_CHECK_ENABLED,
  SIGNUP_FILTER_MODE,
  SIGNUP_RATE_LIMIT_ACTION,
  UNCONFIRMED_SIGNUP_CLEANUP_MODE,
  UNCONFIRMED_SIGNUP_MAX_AGE_HOURS,
  UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN,
  VERIFICATION_LIMITS_MODE,
  VOTE_DAILY_CAP_MODE,
  VOTE_RESTAMP_MODE,
} from '../config/abuse-limits';
import {
  APP_ATTEST_FUNCTION_NAME,
  APP_ATTEST_MEMORY_MB,
  APP_ATTEST_TABLE_NAME,
  APP_ATTEST_TIMEOUT_SECONDS,
  DEVICE_CHECK_SECRET_NAME,
  type MethodThrottle,
} from '../config/app-attest-constants';
import {
  CLEANUP_ORPHANED_USERS_ASYNC_RETRY_ATTEMPTS,
  GENERATE_WEEKLY_DIGESTS_ASYNC_RETRY_ATTEMPTS,
} from '../config/scheduled-jobs-constants';
import { UserApiCanary } from '../constructs/user-api-canary';
import { UserApiGateway } from '../constructs/user-api-gateway';
import {
  createReleaseBackedLambdaFactory,
  grantCloudWatchMetricNamespaceWrite,
  type ReleaseBackedLambdaFactoryProps,
} from './helpers/lambda-utils';
import {
  addProdAliasWithDeployment,
  billboardApiDeploymentConfig,
  type LambdaDeploymentKind,
  type ProdAliasDeploymentOptions,
} from './helpers/codedeploy-utils';
import { storeBucket, storeTable } from './helpers/data-store-refs';
import {
  BILL_COMPANION_ENVIRONMENT,
  grantCompanionGroupsRead,
  grantCompanionGroupsWrite,
} from './helpers/bill-companions';
import {
  grantScheduledJobFailuresSend,
  scheduledJobFailureDestination,
  scheduledJobFailuresQueue,
} from './helpers/scheduled-job-failures';

/** The dotted versions the services accept as MIN_APP_VERSION (parseAppVersion in services/src/shared/appAttest/config.ts). */
const APP_VERSION_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,2}$/;

/**
 * MIN_APP_VERSION as function environment: nothing while it is empty (unset and empty mean the same to the
 * handlers). A value the handlers could not parse would silently gate nothing, so synth refuses it.
 */
const minAppVersionEnvironment = (minAppVersion: string): Record<string, string> => {
  if (minAppVersion === '') return {};
  if (!APP_VERSION_PATTERN.test(minAppVersion)) {
    throw new Error(
      `MIN_APP_VERSION "${minAppVersion}" is not one to three dot-separated numbers (lib/config/abuse-limits.ts).`,
    );
  }
  return { MIN_APP_VERSION: minAppVersion };
};

export interface UserAPIServiceStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucket: s3.IBucket;
  readonly billPriorityTable: ddb.ITable;
  readonly smokeTestSecretName?: string;
  readonly smokeTestFixturesSecretName?: string;
  readonly smokeTestWriteChecksEnabled?: boolean;
}

/** A release-backed function and its `prod` alias. */
interface ProdFunction {
  readonly fn: lambda.Function;
  readonly alias: lambda.Alias;
}

export class UserAPIServiceStack extends cdk.Stack {
  public readonly userApi: apigateway.RestApi;
  public readonly sharePublicOriginApiKeyValue: string;
  /** prod aliases — use for all downstream invocations */
  public readonly registerUserDevice: lambda.IFunction;
  public readonly deviceNotificationSettings: lambda.IFunction;
  public readonly fetchFeedback: lambda.IFunction;
  public readonly setFeedback: lambda.IFunction;
  public readonly fetchBillStats: lambda.IFunction;
  public readonly deletePreferences: lambda.IFunction;
  public readonly fetchPreferences: lambda.IFunction;
  public readonly setPreferences: lambda.IFunction;
  public readonly fetchBillsManifest: lambda.IFunction;
  public readonly publishBillsManifest: lambda.IFunction;
  public readonly fetchCongressMembersManifest: lambda.IFunction;
  public readonly fetchProcessedBill: lambda.IFunction;
  public readonly fetchProcessedCongressMembers: lambda.IFunction;
  public readonly fetchCivicScore: lambda.IFunction;
  public readonly fetchCivicProfile: lambda.IFunction;
  public readonly fetchCongressMemberCivicProfile: lambda.IFunction;
  public readonly districtVerification: lambda.IFunction;
  public readonly adultAttestation: lambda.IFunction;
  public readonly fetchMe: lambda.IFunction;
  public readonly fetchLatestWeeklyDigest: lambda.IFunction;
  public readonly generateWeeklyDigests: lambda.IFunction;
  public readonly weeklyDigestWorker: lambda.IFunction;
  public readonly accountData: lambda.IFunction;
  public readonly accountDataStatus: lambda.IFunction;
  public readonly cleanupOrphanedUsers: lambda.IFunction;
  public readonly exportCognitoUsers: lambda.IFunction;
  /** INT-05: the user pool's PreSignUp trigger (while PRE_SIGN_UP_TRIGGER_ENABLED). */
  public readonly preSignUpCheck: lambda.IFunction;
  /** INT-03: re-stamps an account's stored votes after its verification changes (RestampUserVotesQueue). */
  public readonly restampUserVotes: lambda.IFunction;
  /** INT-04: POST /app-attest/challenge and POST /app-attest/attest (public routes). */
  public readonly appAttest: lambda.IFunction;
  /** CB-07: the daily proof of the sign-up filter (off while SIGNUP_FILTER_CHECK_ENABLED is 'false'). */
  public readonly signUpFilterCheck: lambda.IFunction;

  constructor(scope: Construct, id: string, props: UserAPIServiceStackProps) {
    super(scope, id, props);

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'UserApiServiceApp', {
      applicationName: 'UserApiService',
    });
    // CON-08: API handlers shift 10% for 10 minutes (CodeDeploy's built-in config), then 100%. The custom
    // 20% / 2-hour UserApiServiceDeploymentConfig resource is gone; the groups point at the built-in before
    // CodeDeploy runs, so the deploy that ships this already uses it. Workers still shift all at once.
    const deploymentConfig = billboardApiDeploymentConfig();

    // Shared alarm for API Gateway 5XX — attached to every user-facing Lambda deployment group
    const apiGw5xxAlarm = new cloudwatch.Alarm(this, 'ApiGw5xxAlarm', {
      alarmDescription: 'API Gateway 5XX error rate elevated',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: { ApiName: USER_API_NAME },
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const userPool = new cognito.UserPool(this, 'BillboardUserPool', {
      userPoolName: 'BillboardUserPool',
      signInAliases: {
        email: true,
      },
      selfSignUpEnabled: true,
      // REL-54 step 2 (docs/RUNBOOK.md 23.4): every code email goes through SES on EmailStack's identity
      // (EmailSendingAccount DEVELOPER), from "Billboard <no-reply@billboard-project.com>" with Reply-To
      // contact@billboard-project.com and the configuration set BillboardAccountEmail, instead of Cognito's default
      // sender (no-reply@verificationemail.com, about 50 emails a day). The identity is named by its fixed ARN,
      // arn:<partition>:ses:<region>:<account>:identity/billboard-project.com, and the configuration set by its fixed
      // name: no CloudFormation export, so EmailStack never becomes un-updatable for an import. This stack's region
      // is EmailStack's (both use the app's one environment). Cognito sends with its service-linked role
      // AWSServiceRoleForAmazonCognitoIdpEmailService (created by the deploy if missing), which needs no sending
      // authorization policy on a same-account identity. Every changed property updates the pool in place; a revert
      // returns it to COGNITO_DEFAULT and the old copy. test/app-wide-invariants.test.ts pins both.
      email: cognito.UserPoolEmail.withSES({
        sesRegion: this.region,
        sesVerifiedDomain: EMAIL_DOMAIN,
        fromEmail: ACCOUNT_EMAIL_FROM_ADDRESS,
        fromName: ACCOUNT_EMAIL_FROM_NAME,
        replyTo: ACCOUNT_EMAIL_REPLY_TO,
        configurationSetName: SES_CONFIGURATION_SET_NAME,
      }),
      // The project's copy (2026-10-29). Cognito uses this one template for the sign-up code, a resent code, a changed
      // email address's code and the forgot-password code (lib/config/email-constants.ts).
      userVerification: {
        emailSubject: VERIFICATION_EMAIL_SUBJECT,
        emailBody: VERIFICATION_EMAIL_BODY,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      deletionProtection: true,
      standardAttributes: {
        email: { required: true, mutable: true },
        address: { required: false, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
      customAttributes: {
        state: new cognito.StringAttribute({ mutable: true, maxLen: 2 }),
        district: new cognito.StringAttribute({ mutable: true, maxLen: 16 }),
        politicalParty: new cognito.StringAttribute({ mutable: true, maxLen: 32 }),
      },
    });

    // The iOS app signs in with Amplify's default SRP flow and has no hosted UI.
    const userPoolClient = userPool.addClient('UserPoolClient', {
      userPoolClientName: 'BillboardUserPoolClient',
      authFlows: {
        userSrp: true,
      },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });
    // USER_PASSWORD_AUTH is needed only by the Synthetics canary, so it lives on its own client.
    const canaryUserPoolClient = userPool.addClient('BillboardCanaryClient', {
      userPoolClientName: 'BillboardCanaryClient',
      authFlows: {
        userPassword: true,
      },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });
    const sharePublicOriginApiKeySecret = new secretsmanager.Secret(this, 'SharePublicOriginApiKeySecret', {
      secretName: 'Billboard/SharePublicOriginApiKey',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
    });
    this.sharePublicOriginApiKeyValue = sharePublicOriginApiKeySecret.secretValue.unsafeUnwrap();
    const districtVerificationHashSaltSecret = new secretsmanager.Secret(this, 'DistrictVerificationHashSaltSecret', {
      secretName: 'Billboard/DistrictVerificationHashSalt',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
      // A new salt would invalidate every stored district hash.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // INF-15: the sign-up filter check's probe token. The check address is public, so PreSignUpCheck treats a sign-up
    // to it as the check's probe (a PROBE# record, the probe labels) only when its ClientMetadata carries this token,
    // which SignUpFilterCheck sends. Generated here; only those two functions can read it, and neither logs it. A new
    // value (a replaced secret) needs nothing else: both read it at their next cold start.
    const signUpProbeTokenSecret = new secretsmanager.Secret(this, 'SignUpProbeTokenSecret', {
      secretName: 'Billboard/SignUpProbeToken',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    const apnsPlatformApplicationArn = cdk.Stack.of(this).formatArn({
      service: 'sns',
      resource: 'app',
      resourceName: `APNS/${APNS_PLATFORM_APPLICATION_NAME}`,
    });
    const apnsPlatformEndpointArn = cdk.Stack.of(this).formatArn({
      service: 'sns',
      resource: 'endpoint',
      resourceName: `APNS/${APNS_PLATFORM_APPLICATION_NAME}/*`,
    });
    const createUserApiLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
    );
    // The CodeDeploy groups of the API handlers; the Synthetics canary alarm is added to these only.
    const apiDeploymentGroups: codedeploy.LambdaDeploymentGroup[] = [];
    // Creates the function, its `prod` alias and its CodeDeploy group. API handlers also roll back
    // on the API Gateway 5XX alarm and the canary alarm; workers shift all traffic at once and keep
    // only their own alias error alarm (see codedeploy-utils.ts).
    const addProdFunction = (
      functionName: string,
      artifactName: string,
      lambdaProps: ReleaseBackedLambdaFactoryProps,
      deploymentKind: LambdaDeploymentKind = 'api',
      aliasOptions: Omit<ProdAliasDeploymentOptions, 'deploymentKind'> = {},
    ): ProdFunction => {
      const fn = createUserApiLambda(functionName, artifactName, lambdaProps);
      const { alias, deploymentGroup } = addProdAliasWithDeployment(
        this, functionName, fn, codeDeployApp, deploymentConfig,
        deploymentKind === 'api' ? [apiGw5xxAlarm] : [], { ...aliasOptions, deploymentKind },
      );
      if (deploymentKind === 'api') apiDeploymentGroups.push(deploymentGroup);
      return { fn, alias };
    };
    const piiTableReferenceEnvironment = {
      PII_TABLE_NAME: USER_PII_TABLE_NAME,
      PII_PARTITION_KEY: USER_PARTITION_KEY,
    };
    const userPiiEnvironment = {
      TABLE_NAME: USER_PII_TABLE_NAME,
      PARTITION_KEY: USER_PARTITION_KEY,
    };
    const feedbackTableEnvironment = {
      TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
      PARTITION_KEY: USER_PARTITION_KEY,
    };
    const weeklyDigestTableEnvironment = {
      TABLE_NAME: USER_WEEKLY_DIGESTS_TABLE_NAME,
      PARTITION_KEY: USER_PARTITION_KEY,
      SORT_KEY: USER_WEEKLY_DIGESTS_SORT_KEY,
    };
    const weeklyDigestScheduleEnvironment = {
      CANONICAL_SCHEDULE_EXPRESSION: WEEKLY_DIGEST_CANONICAL_SCHEDULE_EXPRESSION,
      CANONICAL_PUBLISH_TIMEZONE: WEEKLY_DIGEST_CANONICAL_PUBLISH_TIMEZONE,
      CANONICAL_PUBLISH_DAY: WEEKLY_DIGEST_CANONICAL_PUBLISH_DAY,
      CANONICAL_PUBLISH_HOUR: WEEKLY_DIGEST_CANONICAL_PUBLISH_HOUR.toString(),
      CANONICAL_PUBLISH_MINUTE: WEEKLY_DIGEST_CANONICAL_PUBLISH_MINUTE.toString(),
    };
    const accountDataEnvironment = {
      PII_TABLE_NAME: USER_PII_TABLE_NAME,
      PII_PARTITION_KEY: USER_PARTITION_KEY,
      PREFERENCES_TABLE_NAME: USER_PREFERENCES_TABLE_NAME,
      PREFERENCES_PARTITION_KEY: USER_PARTITION_KEY,
      PREFERENCES_SORT_KEY: USER_PREFERENCES_SORT_KEY,
      DEVICES_TABLE_NAME: USER_DEVICES_TABLE_NAME,
      DEVICES_PARTITION_KEY: USER_PARTITION_KEY,
      DEVICES_SORT_KEY: USER_DEVICES_SORT_KEY,
      FEEDBACK_TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
      FEEDBACK_PARTITION_KEY: USER_PARTITION_KEY,
      FEEDBACK_SORT_KEY: USER_FEEDBACK_SORT_KEY,
      FEEDBACK_BILL_ID_INDEX_NAME: USER_FEEDBACK_BILL_ID_INDEX,
      WEEKLY_DIGESTS_TABLE_NAME: USER_WEEKLY_DIGESTS_TABLE_NAME,
      WEEKLY_DIGESTS_PARTITION_KEY: USER_PARTITION_KEY,
      WEEKLY_DIGESTS_SORT_KEY: USER_WEEKLY_DIGESTS_SORT_KEY,
      STATS_TABLE_NAME: USER_BILL_STATS_TABLE_NAME,
      STATS_PARTITION_KEY: USER_BILL_STATS_PARTITION_KEY,
      // X5: the account deletion's three account-integrity steps, each skipped while its variable is unset:
      // (a) release the address claim, (b) delete the sign-up email claim (EMAIL# and USER# items), (c) delete the
      // App Attest USER#<sub> partition. The names are the ones DistrictVerification, PreSignUpCheck and the App
      // Attest functions read. CleanupOrphanedUsers gets the same variables, with read grants only (X23).
      ADDRESS_CLAIMS_TABLE_NAME: VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
      SIGNUP_EMAIL_CLAIMS_TABLE_NAME: SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
      APP_ATTEST_TABLE_NAME,
    };

    // The store tables and buckets, referenced by their fixed names (CQ-15). Each function below is
    // granted exactly what it reads or writes.
    const preferencesTable = storeTable(this, 'userPreferences');
    const devicesTable = storeTable(this, 'userDevices');
    const feedbackTable = storeTable(this, 'userFeedback');
    const billStatsTable = storeTable(this, 'billStats');
    const piiTable = storeTable(this, 'userPii');
    const weeklyDigestsTable = storeTable(this, 'userWeeklyDigests');
    const billStoreBucket = storeBucket(this, 'billStore');
    const billsManifestTable = storeTable(this, 'billsManifest');
    const congressMemberStoreBucket = storeBucket(this, 'congressMemberStore');
    const congressMembersManifestTable = storeTable(this, 'congressMembersManifest');
    const congressMemberStatsTable = storeTable(this, 'congressMemberStats');
    const voteProfilesTable = storeTable(this, 'congressMemberVoteProfiles');
    const legislativeProfilesTable = storeTable(this, 'congressMemberLegislativeProfiles');
    const verifiedAddressClaimsTable = storeTable(this, 'verifiedAddressClaims');
    const signUpEmailClaimsTable = storeTable(this, 'signUpEmailClaims');
    const appAttestTable = storeTable(this, 'appAttest');

    // INT-04 (C3 3.1): what SetFeedback and PreSignUpCheck share for the App Attest check: the table, the key
    // environments allowed under enforce, the per-key account limit, fail-open, and the minimum app version.
    // Each function gets its own APP_ATTEST_MODE below, so votes and sign-ups switch separately. Old builds send
    // no header or ClientMetadata: their outcome is `missing`, with no table call, so nothing here changes them.
    const appAttestCheckEnvironment: Record<string, string> = {
      APP_ATTEST_TABLE_NAME,
      APP_ATTEST_ALLOWED_ENVIRONMENTS,
      APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(APP_ATTEST_MAX_ACCOUNTS_PER_KEY),
      APP_ATTEST_FAIL_CLOSED: String(APP_ATTEST_FAIL_CLOSED),
      ...minAppVersionEnvironment(MIN_APP_VERSION),
    };

    // ── Lambda functions + prod aliases ──────────────────────────────────────

    const registerUserDevice = addProdFunction('RegisterUserDevice', 'registerUserDevice', {
      environment: {
        APNS_PLATFORM_APPLICATION_ARN: apnsPlatformApplicationArn,
        TABLE_NAME: USER_DEVICES_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
        SORT_KEY: USER_DEVICES_SORT_KEY,
        PUSH_TOKEN_INDEX: USER_DEVICES_PUSH_TOKEN_INDEX,
        ...piiTableReferenceEnvironment,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    });
    registerUserDevice.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:CreatePlatformEndpoint'],
        resources: [apnsPlatformApplicationArn],
      })
    );
    registerUserDevice.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:SetEndpointAttributes'],
        resources: [apnsPlatformEndpointArn],
      })
    );
    this.registerUserDevice = registerUserDevice.alias;
    devicesTable.grantReadWriteData(this.registerUserDevice);
    piiTable.grantReadData(this.registerUserDevice);

    this.deviceNotificationSettings = addProdFunction('DeviceNotificationSettings', 'deviceNotificationSettings', {
      environment: {
        TABLE_NAME: USER_DEVICES_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
        SORT_KEY: USER_DEVICES_SORT_KEY,
        ...piiTableReferenceEnvironment,
        NOTIFICATIONS_ENABLED_ATTRIBUTE: 'notificationsEnabled',
        NOTIFY_NEW_ATTRIBUTE: 'notifyNew',
        NOTIFY_UPDATED_ATTRIBUTE: 'notifyUpdated',
        NOTIFY_ALERT_ATTRIBUTE: 'notifyAlert',
        NOTIFY_PASSED_ATTRIBUTE: 'notifyPassed',
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    devicesTable.grantReadWriteData(this.deviceNotificationSettings);
    piiTable.grantReadData(this.deviceNotificationSettings);

    this.deletePreferences = addProdFunction('DeletePreferences', 'deletePreferences', {
      environment: {
        TABLE_NAME: USER_PREFERENCES_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
        SORT_KEY: USER_PREFERENCES_SORT_KEY,
        ...piiTableReferenceEnvironment,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    preferencesTable.grantWriteData(this.deletePreferences);
    // REL-42: a bill's DELETE also Queries the user's rows beginning with its plain guid, to remove the rows stored
    // under a legacy id (BILLS-119hr1181rh). Query only; the base table, no index.
    iam.Grant.addToPrincipal({
      grantee: this.deletePreferences,
      actions: ['dynamodb:Query'],
      resourceArns: [preferencesTable.tableArn],
    });
    piiTable.grantReadData(this.deletePreferences);

    this.fetchPreferences = addProdFunction('FetchPreferences', 'fetchPreferences', {
      environment: {
        TABLE_NAME: USER_PREFERENCES_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    preferencesTable.grantReadData(this.fetchPreferences);

    this.setPreferences = addProdFunction('SetPreferences', 'setPreferences', {
      environment: {
        TABLE_NAME: USER_PREFERENCES_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
        SORT_KEY: USER_PREFERENCES_SORT_KEY,
        ...piiTableReferenceEnvironment,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    preferencesTable.grantWriteData(this.setPreferences);
    piiTable.grantReadData(this.setPreferences);

    const fetchProcessedBill = addProdFunction('FetchProcessedBill', 'fetchProcessedBill', {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        PRIORITY_TABLE_NAME: props.billPriorityTable.tableName,
        PRIORITY_TABLE_PARTITION_KEY: BILL_PRIORITY_TABLE_PARTITION_KEY,
        // APPF-23: adds companionGroup to a grouped bill (both routes).
        ...BILL_COMPANION_ENVIRONMENT,
      },
      timeout: cdk.Duration.seconds(10),
    });
    props.billPriorityTable.grantReadData(fetchProcessedBill.fn);
    this.fetchProcessedBill = fetchProcessedBill.alias;
    billStoreBucket.grantRead(this.fetchProcessedBill);
    grantCompanionGroupsRead(this, this.fetchProcessedBill);

    this.fetchFeedback = addProdFunction('FetchFeedback', 'fetchFeedback', {
      environment: {
        ...feedbackTableEnvironment,
        SORT_KEY: USER_FEEDBACK_SORT_KEY,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    feedbackTable.grantReadData(this.fetchFeedback);

    this.setFeedback = addProdFunction('SetFeedback', 'setFeedback', {
      environment: {
        ...feedbackTableEnvironment,
        SORT_KEY: USER_FEEDBACK_SORT_KEY,
        ...piiTableReferenceEnvironment,
        MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
        MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
        // INT-06: the daily vote cap per account per UTC day (see the constant).
        VOTE_DAILY_CAP_MODE,
        // INT-04 (C3 3.4): the vote's App Attest check, before the INT-06 counter. Under watch every vote is
        // written, with its outcome in the row's appAttest attribute. Members of the exempt group are never
        // blocked under enforce.
        APP_ATTEST_MODE: APP_ATTEST_VOTE_MODE,
        ...appAttestCheckEnvironment,
        APP_ATTEST_EXEMPT_GROUP,
      },
      timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
    }).alias;
    feedbackTable.grantWriteData(this.setFeedback);
    // UX-31: the caller's row on the bill is read (one consistent GetItem keyed by the authorizer's sub) before it
    // is replaced, so a changed vote keeps the time of the first vote on the bill.
    iam.Grant.addToPrincipal({
      grantee: this.setFeedback,
      actions: ['dynamodb:GetItem'],
      resourceArns: [feedbackTable.tableArn],
    });
    piiTable.grantReadData(this.setFeedback);
    // INT-06: the daily counter (voteDay, voteDayCount) is one conditional UpdateItem on the caller's UserPII
    // row, which also creates the row for a user who has none. No other UserPII write.
    iam.Grant.addToPrincipal({
      grantee: this.setFeedback,
      actions: ['dynamodb:UpdateItem'],
      resourceArns: [piiTable.tableArn],
    });
    // The bill's manifest row and status, and for INT-11 the companion groups and REL-50's "formerly failed" markers
    // (pk BILL_FORMERLY_FAILED), all read with GetItem.
    billsManifestTable.grantReadData(this.setFeedback);
    // INT-04: consume the challenge and advance the key's counter (UpdateItem), read the key and the account's
    // binding (GetItem), create a binding and count the key's accounts in one TransactWriteItems (checked as
    // PutItem and UpdateItem), and refresh the binding (UpdateItem).
    iam.Grant.addToPrincipal({
      grantee: this.setFeedback,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resourceArns: [appAttestTable.tableArn],
    });

    this.fetchBillStats = addProdFunction('FetchBillStats', 'fetchBillStats', {
      environment: {
        STATS_TABLE_NAME: USER_BILL_STATS_TABLE_NAME,
        STATS_PARTITION_KEY: USER_BILL_STATS_PARTITION_KEY,
        // APPF-23 scope=companions: serves the group's stats document, or folds the members' votes
        // itself (without writing) when BillStatsAggregator has not stored one yet.
        ...BILL_COMPANION_ENVIRONMENT,
        FEEDBACK_TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
        FEEDBACK_PARTITION_KEY: USER_PARTITION_KEY,
        FEEDBACK_SORT_KEY: USER_FEEDBACK_SORT_KEY,
        FEEDBACK_BILL_ID_INDEX_NAME: USER_FEEDBACK_BILL_ID_INDEX,
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    billStatsTable.grantReadData(this.fetchBillStats);
    grantCompanionGroupsRead(this, this.fetchBillStats);
    // The on-the-fly fold queries the bill-id index only; it projects every attribute, userId included.
    iam.Grant.addToPrincipal({
      grantee: this.fetchBillStats,
      actions: ['dynamodb:Query'],
      resourceArns: [`${feedbackTable.tableArn}/index/${USER_FEEDBACK_BILL_ID_INDEX}`],
    });
    // INT-11: results only after the caller's own vote. The handler reads the caller's rows for the bill and
    // its companion with one consistent BatchGetItem keyed by the authorizer's sub, and nothing else on the
    // table: no GetItem, which would only widen what the role can read of other users' votes.
    iam.Grant.addToPrincipal({
      grantee: this.fetchBillStats,
      actions: ['dynamodb:BatchGetItem'],
      resourceArns: [feedbackTable.tableArn],
    });

    this.fetchCivicScore = addProdFunction('FetchCivicScore', 'fetchCivicScore', {
      environment: {
        ...feedbackTableEnvironment,
        // APPF-23: a companion pair counts once (the primary's vote wins).
        ...BILL_COMPANION_ENVIRONMENT,
        // UX-31: the Civic Score record (the parts of the score that never go down, the honors earned, the switch
        // to Eastern days) on the caller's UserPII row.
        ...piiTableReferenceEnvironment,
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    feedbackTable.grantReadData(this.fetchCivicScore);
    grantCompanionGroupsRead(this, this.fetchCivicScore);
    // UX-31: one consistent GetItem of the caller's UserPII row per read and, when the record changed, one UpdateItem
    // of its civic* attributes, conditioned on the row existing and not being deleted (it never creates the row).
    iam.Grant.addToPrincipal({
      grantee: this.fetchCivicScore,
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resourceArns: [piiTable.tableArn],
    });

    this.fetchCivicProfile = addProdFunction('FetchCivicProfile', 'fetchCivicProfile', {
      environment: {
        ...feedbackTableEnvironment,
        // APPF-23: a companion pair counts once (the primary's vote wins). Its manifest read grant
        // covers the groups row.
        ...BILL_COMPANION_ENVIRONMENT,
        // Resolves civic profile metadata for feedback rows that predate the stored
        // snapshot; without MANIFEST_TABLE_NAME the handler skips that lookup.
        MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
        MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
        MANIFEST_SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
        MANIFEST_GUID_LOOKUP_PK: `${BILLS_MANIFEST_TABLE_PK_VALUE}_GUID`,
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    feedbackTable.grantReadData(this.fetchCivicProfile);
    billsManifestTable.grantReadData(this.fetchCivicProfile);

    this.fetchCongressMemberCivicProfile = addProdFunction(
      'FetchCongressMemberCivicProfile',
      'fetchCongressMemberCivicProfile',
      {
        environment: {
          TABLE_NAME: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
          PARTITION_KEY: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY,
          LEGISLATIVE_TABLE_NAME: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
          LEGISLATIVE_PARTITION_KEY: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY,
          MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
          MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
          MANIFEST_SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
          MANIFEST_PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
          MANIFEST_GUID_LOOKUP_PK: `${BILLS_MANIFEST_TABLE_PK_VALUE}_GUID`,
        },
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
      },
    ).alias;
    billsManifestTable.grantReadData(this.fetchCongressMemberCivicProfile);
    voteProfilesTable.grantReadData(this.fetchCongressMemberCivicProfile);
    legislativeProfilesTable.grantReadData(this.fetchCongressMemberCivicProfile);

    // ── INT-03 vote re-stamp (C2 3.3.4, X8) ──────────────────────────────────
    //
    // DistrictVerification sends {"userId": "<sub>"} here (10-second delay) before it writes a verification
    // change; RestampUserVotes then brings the account's stored votes to the same stamp. Idempotent: a retry,
    // a redrive or a hand-sent message converges on the account's current UserPII row.
    const restampUserVotesDLQ = new sqs.Queue(this, 'RestampUserVotesDLQ', {
      queueName: RESTAMP_USER_VOTES_DLQ_NAME,
      retentionPeriod: cdk.Duration.days(RESTAMP_USER_VOTES_DLQ_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const restampUserVotesQueue = new sqs.Queue(this, 'RestampUserVotesQueue', {
      queueName: RESTAMP_USER_VOTES_QUEUE_NAME,
      visibilityTimeout: cdk.Duration.seconds(RESTAMP_USER_VOTES_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: RESTAMP_USER_VOTES_DLQ_MAX_RECEIVE_COUNT,
        queue: restampUserVotesDLQ,
      },
    });

    const restampUserVotes = addProdFunction('RestampUserVotes', 'restampUserVotes', {
      environment: {
        ...piiTableReferenceEnvironment,
        FEEDBACK_TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
        FEEDBACK_PARTITION_KEY: USER_PARTITION_KEY,
        FEEDBACK_SORT_KEY: USER_FEEDBACK_SORT_KEY,
        // X8: plan reads and logs the rows it would change and writes nothing; apply rewrites them.
        VOTE_RESTAMP_MODE,
      },
      timeout: cdk.Duration.seconds(RESTAMP_USER_VOTES_TIMEOUT_SECONDS),
    }, 'worker');
    restampUserVotes.alias.addEventSource(
      new SqsEventSource(restampUserVotesQueue, {
        batchSize: RESTAMP_USER_VOTES_BATCH_SIZE,
        maxConcurrency: RESTAMP_USER_VOTES_MAX_CONCURRENCY,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );
    this.restampUserVotes = restampUserVotes.alias;
    // Exactly what the worker does: GetItem the account's UserPII row; Query its UserFeedback partition and
    // UpdateItem each vote row whose stamp differs (apply mode only, conditional on the row still existing).
    iam.Grant.addToPrincipal({
      grantee: this.restampUserVotes,
      actions: ['dynamodb:GetItem'],
      resourceArns: [piiTable.tableArn],
    });
    iam.Grant.addToPrincipal({
      grantee: this.restampUserVotes,
      actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
      resourceArns: [feedbackTable.tableArn],
    });

    const districtVerification = addProdFunction('DistrictVerification', 'districtVerification', {
      environment: {
        ...userPiiEnvironment,
        // The handler reads the salt from this ARN at its first use in a container, so the
        // salt stays out of the function configuration. It has no HASH_SALT variable (UA-15,
        // FN-4): the handler never reads one, and a test pins that no function gets one.
        // Versions published before UA-15 still hold the plaintext salt until they are deleted
        // (RUNBOOK section 7).
        HASH_SALT_SECRET_ARN: districtVerificationHashSaltSecret.secretArn,
        // INT-03 (3A): the verified-accounts-per-address and address-change limits. Watch writes the claims and
        // counters as enforce does but never caps or refuses (see the constant).
        ADDRESS_CLAIMS_TABLE_NAME: VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
        VERIFICATION_LIMITS_MODE,
        // Sent before any write whenever the verification state changes, in both modes.
        VOTE_RESTAMP_QUEUE_URL: restampUserVotesQueue.queueUrl,
      },
      timeout: cdk.Duration.seconds(10),
    });
    districtVerificationHashSaltSecret.grantRead(districtVerification.fn);
    this.districtVerification = districtVerification.alias;
    piiTable.grantReadWriteData(this.districtVerification);
    // Exactly what the claims code does: TransactWriteItems of counter Updates and claim Puts and Deletes
    // (authorised item by item as UpdateItem, PutItem, DeleteItem), the street-count GetItem, and the
    // self-heal's claimant Query and counter BatchGetItem. No Scan: the table is never listed.
    iam.Grant.addToPrincipal({
      grantee: this.districtVerification,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ],
      resourceArns: [verifiedAddressClaimsTable.tableArn],
    });
    restampUserVotesQueue.grantSendMessages(this.districtVerification);

    // ── INT-05: the Cognito pre-sign-up filter (C2 3.5 with X4, X5, X11) ────
    //
    // Runs on every self-service sign-up, through its prod alias. It fails open: an internal error or the
    // 3.5-second deadline lets the sign-up through (PreSignUpCheckError). Deployment kind api: synchronous
    // and user facing, so it gets the 10-minute canary and the API alarms. A brand-new function's alias
    // points at version 1 as soon as this stack deploys, possibly before UserStoreStack creates
    // SignUpEmailClaims; until then every email check errors and fails open.
    //
    // No USER_POOL_ID: the handler takes the pool from the trigger event, and a reference from the function
    // to the pool would close the cycle pool -> alias -> function. Nothing in its default policy may name the
    // pool either (see PreSignUpCheckUserPoolPolicy below).
    const preSignUpCheckEnvironment: Record<string, string> = {
      SIGNUP_FILTER_MODE,
      SIGNUP_EMAIL_CLAIMS_TABLE_NAME: SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
      // The same salt as DistrictVerification's hashes (emailKey = salted hash of the base address). The
      // handler reads it at its first sign-up; there is no plaintext HASH_SALT here.
      HASH_SALT_SECRET_ARN: districtVerificationHashSaltSecret.secretArn,
      // INT-04 (C3 3.5, X4): App Attest, then DeviceCheck, after the email checks, inside the same 3.5-second
      // deadline, in the modes lib/config/abuse-limits.ts sets. Under watch App Attest never throws (R2's
      // ClientMetadata assertion is verified and counted); DeviceCheck off makes no Apple call and reads no secret.
      APP_ATTEST_MODE: APP_ATTEST_SIGN_UP_MODE,
      ...appAttestCheckEnvironment,
      DEVICE_CHECK_MODE,
      DEVICE_CHECK_SECRET_NAME,
      DEVICE_MAX_ACCOUNTS: String(DEVICE_MAX_ACCOUNTS),
      DEVICE_COUNTER_WINDOW_MONTHS: String(DEVICE_COUNTER_WINDOW_MONTHS),
      // CB-07: a sign-up whose base address is this one is the filter check's probe, if it carries the probe token
      // (INF-15). Labels only (SignUpProbeHit and SignUpProbeRejected instead of SignUpFilterHit and SignUpRejected,
      // the probe log key, a PROBE# record); the decision is never different. A plain string, so no reference and no
      // cycle; the token's secret is read only for a sign-up to that address.
      SIGNUP_FILTER_CHECK_ADDRESS,
      SIGNUP_PROBE_TOKEN_SECRET_ARN: signUpProbeTokenSecret.secretArn,
    };
    // Under SIGNUP_FILTER_MODE 'enforce' a refused sign-up is a thrown error (Cognito needs one), and the filter
    // check (CB-07) makes one every day at 11:30 UTC. Its alias error alarm, which rolls back its 10-minute canary,
    // counts Errors less those refusals (SignUpRejected, SignUpProbeRejected), so a refusal does not roll back a
    // correct version and a deploy needs no time window. Under watch nothing is thrown and the two are the same.
    const preSignUpCheck = addProdFunction('PreSignUpCheck', 'preSignUp', {
      environment: preSignUpCheckEnvironment,
      memorySize: PRE_SIGN_UP_CHECK_MEMORY_MB,
      timeout: cdk.Duration.seconds(PRE_SIGN_UP_CHECK_TIMEOUT_SECONDS),
    }, 'api', {
      intentionalErrorMetrics: PRE_SIGN_UP_CHECK_INTENTIONAL_ERROR_METRICS.map((metricName) => new cloudwatch.Metric({
        namespace: ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      })),
    });
    this.preSignUpCheck = preSignUpCheck.alias;
    districtVerificationHashSaltSecret.grantRead(preSignUpCheck.fn);
    signUpProbeTokenSecret.grantRead(preSignUpCheck.fn);
    // GetItem EMAIL#<emailKey>, then one TransactWriteItems of two Puts (EMAIL# and USER#), which IAM
    // authorises as PutItem; on a hit whose live holder the claim does not name, one conditional PutItem that names
    // it; when a later check refuses the sign-up, GetItem EMAIL# and one conditional PutItem that takes the sign-up
    // off it (or frees it); for the filter check's probes (CB-07), one unconditional PutItem of PROBE#base or
    // PROBE#variant.
    // Nothing else: no Scan, no delete (account deletion releases claims, X5).
    iam.Grant.addToPrincipal({
      grantee: this.preSignUpCheck,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resourceArns: [signUpEmailClaimsTable.tableArn],
    });
    // INT-04: consume the sign-up challenge, advance the key's counter and count its sign-ups (UpdateItem), and
    // read the key (GetItem). No PutItem: sign-up creates no binding (no account exists yet).
    iam.Grant.addToPrincipal({
      grantee: this.preSignUpCheck,
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resourceArns: [appAttestTable.tableArn],
    });
    // The DeviceCheck key, by name: the secret is created by hand and may not exist, and a grant on a name that
    // does not resolve is harmless. Read only when DEVICE_CHECK_MODE is not off. "-??????" is Secrets Manager's
    // random suffix.
    iam.Grant.addToPrincipal({
      grantee: this.preSignUpCheck,
      actions: ['secretsmanager:GetSecretValue'],
      resourceArns: [
        cdk.Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${DEVICE_CHECK_SECRET_NAME}-??????`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    });
    // AdminGetUser tells a live claim holder from a deleted account or an abandoned unconfirmed sign-up. A
    // standalone policy, not the role's default policy: the function depends on its default policy, the pool
    // references the alias as its trigger, and a default policy naming the pool would close a dependency
    // cycle (pool -> alias -> version -> function -> default policy -> pool).
    new iam.Policy(this, 'PreSignUpCheckUserPoolPolicy', {
      roles: [preSignUpCheck.fn.role!],
      statements: [
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminGetUser'],
          resources: [userPool.userPoolArn],
        }),
      ],
    });
    // PRE_SIGN_UP_TRIGGER_ENABLED is the kill switch: false leaves the function in place and the pool without
    // a LambdaConfig, exactly as before the trigger existed. The pool's only template change is its LambdaConfig (X21).
    if (PRE_SIGN_UP_TRIGGER_ENABLED) {
      userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUpCheck.alias);
    }

    // ── INT-04: App Attest (C3 3.2, 3.3, 3.7; switches in abuse-limits.ts) ──
    //
    // One function behind both public routes (addRoutes). It verifies attestations offline (no Apple call) and
    // writes only the AppAttest table. Deployment kind api: the 10-minute canary with the API alarms. A
    // brand-new function's alias points at version 1 as soon as this stack deploys, before UserStoreStack
    // creates the table; until then both routes answer 503 APP_ATTEST_UNAVAILABLE. Only app builds that attest
    // call them.
    const appAttest = addProdFunction(APP_ATTEST_FUNCTION_NAME, 'appAttest', {
      environment: {
        APP_ATTEST_TABLE_NAME,
        // R2's kill switch: off answers {"clientMode": "off"} and stores nothing.
        APP_ATTEST_CLIENT_MODE,
        APP_ATTEST_CHALLENGE_TTL_SECONDS: String(APP_ATTEST_CHALLENGE_TTL_SECONDS),
      },
      memorySize: APP_ATTEST_MEMORY_MB,
      timeout: cdk.Duration.seconds(APP_ATTEST_TIMEOUT_SECONDS),
      // A flood on the public routes can never take concurrency from another function. The routes' own stage
      // throttles (addRoutes) keep calls within it, so the excess gets 429 from API Gateway, not a Lambda
      // throttle (which API Gateway would answer with a 500).
      reservedConcurrentExecutions: APP_ATTEST_RESERVED_CONCURRENCY,
    });
    this.appAttest = appAttest.alias;
    // Put a challenge and an attested key (conditional PutItem), consume a challenge (UpdateItem), read a key.
    iam.Grant.addToPrincipal({
      grantee: this.appAttest,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resourceArns: [appAttestTable.tableArn],
    });

    // Votes by members of this group are never blocked under enforce; their outcomes are still recorded. It
    // references the pool, never the reverse, so the pool's template is unchanged (X21). Created empty.
    new cognito.CfnUserPoolGroup(this, 'AppAttestExemptGroup', {
      userPoolId: userPool.userPoolId,
      groupName: APP_ATTEST_EXEMPT_GROUP,
      description: 'App Attest (INT-04): votes by members are never blocked when APP_ATTEST_MODE is enforce; their outcomes are still recorded. For the canary and UI smoke-test users only.',
    });

    this.adultAttestation = addProdFunction('AdultAttestation', 'adultAttestation', {
      environment: userPiiEnvironment,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    piiTable.grantReadWriteData(this.adultAttestation);

    this.fetchMe = addProdFunction('FetchMe', 'fetchMe', {
      environment: userPiiEnvironment,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    piiTable.grantReadData(this.fetchMe);

    this.fetchLatestWeeklyDigest = addProdFunction('FetchLatestWeeklyDigest', 'fetchLatestWeeklyDigest', {
      environment: {
        ...weeklyDigestTableEnvironment,
        ...weeklyDigestScheduleEnvironment,
      },
      timeout: cdk.Duration.seconds(10),
    }).alias;
    weeklyDigestsTable.grantReadData(this.fetchLatestWeeklyDigest);

    // ── Weekly digest: planner (GenerateWeeklyDigests) and fan-out worker (CAP-03) ──

    // Everything digest generation reads, shared by the planner and the worker. The worker rejects a
    // window id that is not a release instant under its own schedule settings, so both must get
    // exactly the same weeklyDigestScheduleEnvironment.
    const weeklyDigestGenerationEnvironment = {
      ...weeklyDigestTableEnvironment,
      PREFERENCES_TABLE_NAME: USER_PREFERENCES_TABLE_NAME,
      PREFERENCES_PARTITION_KEY: USER_PARTITION_KEY,
      PREFERENCES_SORT_KEY: USER_PREFERENCES_SORT_KEY,
      FEEDBACK_TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
      FEEDBACK_PARTITION_KEY: USER_PARTITION_KEY,
      FEEDBACK_SORT_KEY: USER_FEEDBACK_SORT_KEY,
      // APPF-23: a companion pair is one digest candidate. The manifest read grants cover the groups row.
      ...BILL_COMPANION_ENVIRONMENT,
      MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
      MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
      MANIFEST_PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
      MANIFEST_SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
      CONGRESS_MEMBERS_TABLE_NAME: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
      CONGRESS_MEMBERS_PRIMARY_KEY: CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY,
      BUCKET_NAME: BILL_STORE_BUCKET_NAME,
      ...weeklyDigestScheduleEnvironment,
    };

    // The planner sends every user here, 25 per message, each Sunday; a message with any failed
    // user is retried whole (users already stored are skipped) and dead-lettered after 3 receives.
    const weeklyDigestDLQ = new sqs.Queue(this, 'WeeklyDigestDLQ', {
      queueName: 'WeeklyDigestDLQ',
      retentionPeriod: cdk.Duration.days(WEEKLY_DIGEST_DLQ_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const weeklyDigestQueue = new sqs.Queue(this, 'WeeklyDigestQueue', {
      queueName: 'WeeklyDigestQueue',
      visibilityTimeout: cdk.Duration.seconds(WEEKLY_DIGEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: WEEKLY_DIGEST_DLQ_MAX_RECEIVE_COUNT,
        queue: weeklyDigestDLQ,
      },
    });

    const generateWeeklyDigests = addProdFunction('GenerateWeeklyDigests', 'generateWeeklyDigests', {
      environment: {
        ...weeklyDigestGenerationEnvironment,
        // Only the planner lists users (a UserPII scan).
        ...piiTableReferenceEnvironment,
        // Set: the scheduled run enqueues everyone for WeeklyDigestWorker. A run that names userIds
        // still generates inline.
        WEEKLY_DIGEST_QUEUE_URL: weeklyDigestQueue.queueUrl,
      },
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
    }, 'worker');
    // Publishes WeeklyDigestUsersEnqueued, and WeeklyDigestUsersFailed/Processed on inline runs.
    grantCloudWatchMetricNamespaceWrite(generateWeeklyDigests.fn, WEEKLY_DIGEST_METRIC_NAMESPACE);
    weeklyDigestQueue.grantSendMessages(generateWeeklyDigests.fn);
    this.generateWeeklyDigests = generateWeeklyDigests.alias;
    // The scheduler invokes asynchronously, and a run that fails for some users throws so Lambda reruns
    // it: async retries stay at the default 2, now written out. C1.1: after them the failed run is recorded
    // in ScheduledJobFailures (payload and error) instead of dropped; it can be rerun only before the next
    // Sunday 10:00 New York. Grants the role sqs:SendMessage on the queue.
    generateWeeklyDigests.alias.configureAsyncInvoke({
      retryAttempts: GENERATE_WEEKLY_DIGESTS_ASYNC_RETRY_ATTEMPTS,
      onFailure: scheduledJobFailureDestination(this),
    });
    preferencesTable.grantReadData(this.generateWeeklyDigests);
    feedbackTable.grantReadData(this.generateWeeklyDigests);
    // C1.7: no BillStats read. The planner has no stats variable and never reads the table, and the
    // worker already generates every digest without it.
    piiTable.grantReadData(this.generateWeeklyDigests);
    weeklyDigestsTable.grantReadWriteData(this.generateWeeklyDigests);
    billStoreBucket.grantRead(this.generateWeeklyDigests);
    billsManifestTable.grantReadData(this.generateWeeklyDigests);
    congressMembersManifestTable.grantReadData(this.generateWeeklyDigests);

    // No UserPII variables and no queue URL: the worker only builds the digests its message names.
    const weeklyDigestWorker = addProdFunction('WeeklyDigestWorker', 'weeklyDigestWorker', {
      environment: weeklyDigestGenerationEnvironment,
      memorySize: WEEKLY_DIGEST_WORKER_MEMORY_MB,
      timeout: cdk.Duration.seconds(WEEKLY_DIGEST_WORKER_TIMEOUT_SECONDS),
    }, 'worker');
    // Publishes WeeklyDigestUsersFailed and WeeklyDigestUsersProcessed per message.
    grantCloudWatchMetricNamespaceWrite(weeklyDigestWorker.fn, WEEKLY_DIGEST_METRIC_NAMESPACE);
    weeklyDigestWorker.alias.addEventSource(
      new SqsEventSource(weeklyDigestQueue, {
        batchSize: WEEKLY_DIGEST_WORKER_BATCH_SIZE,
        maxConcurrency: WEEKLY_DIGEST_WORKER_MAX_CONCURRENCY,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );
    this.weeklyDigestWorker = weeklyDigestWorker.alias;
    // No UserPII or BillStats access: the planner lists the users, and digest generation never reads
    // bill stats.
    preferencesTable.grantReadData(this.weeklyDigestWorker);
    feedbackTable.grantReadData(this.weeklyDigestWorker);
    weeklyDigestsTable.grantReadWriteData(this.weeklyDigestWorker);
    billStoreBucket.grantRead(this.weeklyDigestWorker);
    billsManifestTable.grantReadData(this.weeklyDigestWorker);
    congressMembersManifestTable.grantReadData(this.weeklyDigestWorker);

    const accountData = addProdFunction('AccountData', 'accountData', {
      environment: {
        ...accountDataEnvironment,
        USER_POOL_ID: userPool.userPoolId,
        DEVICES_PUSH_TOKEN_INDEX_NAME: USER_DEVICES_PUSH_TOKEN_INDEX,
      },
      memorySize: 512,
      // Also deletes SNS endpoints and the Cognito user; API Gateway gives up at 29 s.
      timeout: cdk.Duration.seconds(28),
    });
    accountData.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminDeleteUser'],
        resources: [userPool.userPoolArn],
      })
    );
    accountData.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:DeleteEndpoint'],
        resources: [apnsPlatformEndpointArn],
      })
    );
    this.accountData = accountData.alias;
    preferencesTable.grantReadWriteData(this.accountData);
    devicesTable.grantReadWriteData(this.accountData);
    feedbackTable.grantReadWriteData(this.accountData);
    // C1.6 step 1 removes the inline BillStats recompute from the code only. Step 2 removes this
    // grant and STATS_* once no release_id rollback target predates that code: an older version that still
    // recomputes inline would otherwise fail its deletion after the data is gone.
    billStatsTable.grantWriteData(this.accountData);
    piiTable.grantReadWriteData(this.accountData);
    weeklyDigestsTable.grantReadWriteData(this.accountData);
    // X5 (a): release the address claim the UserPII row points at, in one transaction that deletes the claim
    // and decrements its unit and street counters (authorized as DeleteItem and UpdateItem). No GetItem: only the
    // cleanup dry run (countUserData, CleanupOrphanedUsers) checks that a claim exists.
    iam.Grant.addToPrincipal({
      grantee: this.accountData,
      actions: ['dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resourceArns: [verifiedAddressClaimsTable.tableArn],
    });
    // X5 (b): read USER#<userName>, then delete it and its EMAIL# item, on condition that the item names the account
    // (as its userName or one of its holders), and the USER# items of the item's other holders.
    iam.Grant.addToPrincipal({
      grantee: this.accountData,
      actions: ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
      resourceArns: [signUpEmailClaimsTable.tableArn],
    });
    // X5 (c): query the account's USER#<sub> partition and delete its bindings (BatchWriteItem). Key rows and their
    // counts stay. C3 WP-C3d also lists DeleteItem; the deletion sends only BatchWriteItem, so it is left out.
    iam.Grant.addToPrincipal({
      grantee: this.accountData,
      actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
      resourceArns: [appAttestTable.tableArn],
    });

    this.accountDataStatus = addProdFunction('AccountDataStatus', 'accountDataStatus', {
      environment: userPiiEnvironment,
      timeout: cdk.Duration.seconds(10),
    }).alias;
    piiTable.grantReadData(this.accountDataStatus);

    const cleanupOrphanedUsers = addProdFunction('CleanupOrphanedUsers', 'cleanupOrphanedUsers', {
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        ...accountDataEnvironment,
        // Log-only while 'true'. Set it to 'false' only once one run's summary has been checked (D3 step 2), in
        // the same change as the write grants on the three account-integrity tables below (X23).
        DRY_RUN: 'true',
        MAX_DELETIONS_PER_RUN: '50',
        // C1.10 (D3 step 1). The abort threshold is max(ORPHAN_ABORT_MIN_COUNT, 2% of users): with a small
        // pool, three or more orphans without a deletion tombstone abort the run (a replaced pool orphans
        // everyone).
        ORPHAN_ABORT_MIN_COUNT: '2',
        // Resume candidates: in_progress deletion claims older than this, at most this many per run. In
        // dry run they are only reported (wouldResume); code before C1.10 ignores both.
        RESUME_MIN_STALE_HOURS: '24',
        MAX_RESUMES_PER_RUN: '10',
        // The shared-endpoint check before deleting a device's SNS endpoint, as in AccountData.
        DEVICES_PUSH_TOKEN_INDEX_NAME: USER_DEVICES_PUSH_TOKEN_INDEX,
        // REL-53: sign-ups left UNCONFIRMED longer than the maximum age, under their own switch (not DRY_RUN).
        // The filter check's probes (CB-07) are never deleted here: the check's own sweep removes them.
        UNCONFIRMED_SIGNUP_CLEANUP_MODE,
        UNCONFIRMED_SIGNUP_MAX_AGE_HOURS: String(UNCONFIRMED_SIGNUP_MAX_AGE_HOURS),
        UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: String(UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN),
        SIGNUP_FILTER_CHECK_ADDRESS,
      },
      memorySize: 512,
      timeout: cdk.Duration.minutes(15),
    }, 'worker');
    // ListUsers finds orphans; AdminGetUser rechecks each candidate before deletion.
    cleanupOrphanedUsers.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser'],
        resources: [userPool.userPoolArn],
      })
    );
    this.cleanupOrphanedUsers = cleanupOrphanedUsers.alias;
    preferencesTable.grantReadWriteData(this.cleanupOrphanedUsers);
    devicesTable.grantReadWriteData(this.cleanupOrphanedUsers);
    feedbackTable.grantReadWriteData(this.cleanupOrphanedUsers);
    // C1.6: step 2 removes this BillStats write with AccountData's (see there).
    billStatsTable.grantWriteData(this.cleanupOrphanedUsers);
    piiTable.grantReadWriteData(this.cleanupOrphanedUsers);
    weeklyDigestsTable.grantReadWriteData(this.cleanupOrphanedUsers);
    // X23: read-only on the three account-integrity tables, so the dry run counts what a deletion would remove (the
    // address claim, the email claim, the App Attest bindings). Their write grants come with DRY_RUN=false.
    iam.Grant.addToPrincipal({
      grantee: this.cleanupOrphanedUsers,
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resourceArns: [verifiedAddressClaimsTable.tableArn, signUpEmailClaimsTable.tableArn, appAttestTable.tableArn],
    });
    // REL-53: only with UNCONFIRMED_SIGNUP_CLEANUP_MODE 'delete', the step deletes an unconfirmed sign-up's email claim
    // (DeleteItem USER#<username>, and EMAIL#<emailKey> on condition that it still names the account, as its userName
    // or one of its holders, then the USER# items of its other holders) and then the Cognito user. IAM cannot narrow
    // AdminDeleteUser to unconfirmed users: the handler re-reads each one (AdminGetUser) right before. The orphan path
    // never deletes a Cognito user. The D3 resume path does once DRY_RUN is 'false', and with this grant DRY_RUN is
    // the only thing that stops it (docs/RUNBOOK.md 8.1).
    if (UNCONFIRMED_SIGNUP_CLEANUP_MODE === 'delete') {
      cleanupOrphanedUsers.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminDeleteUser'],
          resources: [userPool.userPoolArn],
        })
      );
      iam.Grant.addToPrincipal({
        grantee: this.cleanupOrphanedUsers,
        actions: ['dynamodb:DeleteItem'],
        resourceArns: [signUpEmailClaimsTable.tableArn],
      });
    }
    // A safety abort throws; retrying would only repeat the five-table scan. The next daily run retries.
    // C1.1 and D3: with no retries its Errors alarm (2 of 3 windows) can never fire, so the abort is
    // recorded in ScheduledJobFailures instead, which alarms. Read the reason in the log before any rerun.
    cleanupOrphanedUsers.alias.configureAsyncInvoke({
      retryAttempts: CLEANUP_ORPHANED_USERS_ASYNC_RETRY_ATTEMPTS,
      onFailure: scheduledJobFailureDestination(this),
    });

    // C1.1: each rule and schedule below sends a delivery it cannot make to ScheduledJobFailures instead of
    // dropping it. EventBridge rules write under SharedInfraStack's queue policy; schedules with their role.
    new events.Rule(this, 'CleanupOrphanedUsersSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(cleanupOrphanedUsers.alias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    // REC-02: nightly export of the Cognito users. Password hashes cannot be exported, so this is
    // what lets people be re-invited if the pool is lost or replaced. The objects hold emails, state
    // and district: ExportCognitoUsers may only write new exports, and nothing is granted read or
    // delete. Retention is short because an export outlives the accounts deleted after it was taken
    // (the privacy policy states it): 14 days, plus 1 for the version an expiry or rerun replaces.
    const cognitoUserExportBucket = new s3.Bucket(this, 'CognitoUserExportBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireCognitoUserExports',
          prefix: COGNITO_USER_EXPORT_PREFIX,
          expiration: cdk.Duration.days(14),
          // Covers a same-day rerun that replaced an export, and the expired exports themselves.
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
        {
          id: 'RemoveExpiredDeleteMarkers',
          prefix: COGNITO_USER_EXPORT_PREFIX,
          expiredObjectDeleteMarker: true,
        },
      ],
    });

    const exportCognitoUsers = addProdFunction('ExportCognitoUsers', 'exportCognitoUsers', {
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        EXPORT_BUCKET: cognitoUserExportBucket.bucketName,
        RETIRED_PROFILE_ATTRIBUTES_MODE,
      },
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
    }, 'worker');
    exportCognitoUsers.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers'],
        resources: [userPool.userPoolArn],
      })
    );
    // UX-36: with RETIRED_PROFILE_ATTRIBUTES_MODE 'clear', and only then, the run deletes the retired profile
    // attributes (party, gender, birth date) after the export. IAM cannot narrow AdminDeleteUserAttributes to those
    // names: the handler sends only them (services/src/shared/retiredProfileAttributes.ts). The app's policy
    // minimization merges this into the ListUsers statement on the pool.
    if (RETIRED_PROFILE_ATTRIBUTES_MODE === 'clear') {
      exportCognitoUsers.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminDeleteUserAttributes'],
          resources: [userPool.userPoolArn],
        })
      );
    }
    // One PutObject per run, under the export prefix only.
    exportCognitoUsers.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [cognitoUserExportBucket.arnForObjects(`${COGNITO_USER_EXPORT_PREFIX}*`)],
      })
    );
    this.exportCognitoUsers = exportCognitoUsers.alias;
    // Retries are safe: a rerun on the same UTC day overwrites that day's object. No failure destination:
    // the 26-hour freshness alarm already reports a failed run, and a destination would report it twice.
    exportCognitoUsers.alias.configureAsyncInvoke({ retryAttempts: 2 });

    new events.Rule(this, 'ExportCognitoUsersSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '8' }),
      targets: [new targets.LambdaFunction(exportCognitoUsers.alias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    // ── CB-07: the sign-up filter check (docs/RUNBOOK.md 14.12) ──────────────
    //
    // Daily, it signs up the check address and a +tag of it through the app's own client (the public SignUp, which
    // needs no IAM), reads what PreSignUpCheck recorded, and deletes both accounts and their claim items. Ships off:
    // SIGNUP_FILTER_CHECK_ENABLED 'false' makes each run emit SignUpFilterCheckDisabled and nothing else. No salt: the
    // email key comes from the account's USER# item. One secret, the probe token (INF-15), which every SignUp carries.
    // SIGNUP_FILTER_CHECK_EXPECTED_MODE is the SIGNUP_FILTER_MODE constant under its own name, so each mode variable
    // stays on exactly one function.
    const signUpFilterCheck = addProdFunction('SignUpFilterCheck', 'signUpFilterCheck', {
      environment: {
        SIGNUP_FILTER_CHECK_ENABLED,
        SIGNUP_FILTER_CHECK_ADDRESS,
        SIGNUP_FILTER_CHECK_EXPECTED_MODE: SIGNUP_FILTER_MODE,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        SIGNUP_EMAIL_CLAIMS_TABLE_NAME: SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
        SIGNUP_PROBE_TOKEN_SECRET_ARN: signUpProbeTokenSecret.secretArn,
      },
      memorySize: SIGNUP_FILTER_CHECK_MEMORY_MB,
      timeout: cdk.Duration.seconds(SIGNUP_FILTER_CHECK_TIMEOUT_SECONDS),
      // One run at a time: two overlapping runs could take each other's half-made base sign-up for their own.
      reservedConcurrentExecutions: SIGNUP_FILTER_CHECK_RESERVED_CONCURRENCY,
    }, 'worker');
    // ListUsers and AdminGetUser find probe accounts; AdminDeleteUser removes them. IAM cannot narrow these to the
    // probe accounts, so the code's one guarded delete path does (an UNCONFIRMED account whose email is a probe
    // address, never a CONFIRMED one). The pool does not reference this function, so naming it here is no cycle.
    signUpFilterCheck.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminGetUser', 'cognito-idp:ListUsers'],
        resources: [userPool.userPoolArn],
      })
    );
    this.signUpFilterCheck = signUpFilterCheck.alias;
    signUpProbeTokenSecret.grantRead(signUpFilterCheck.fn);
    // Strongly consistent GetItem of PROBE#, USER# and EMAIL# items, and conditional DeleteItem of the ones a run or
    // a crashed run left. No PutItem, no Scan, no Query.
    iam.Grant.addToPrincipal({
      grantee: this.signUpFilterCheck,
      actions: ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
      resourceArns: [signUpEmailClaimsTable.tableArn],
    });
    // Never retried: a retry would sign up twice and send two more emails. A failed run is reported by its own
    // metrics, or by the 26-hour freshness alarm when it could not report.
    signUpFilterCheck.alias.configureAsyncInvoke({ retryAttempts: 0 });
    // Always ENABLED (C1.1 checks every rule); the switch decides whether a run does anything.
    new events.Rule(this, 'SignUpFilterCheckSchedule', {
      schedule: events.Schedule.cron(SIGNUP_FILTER_CHECK_SCHEDULE),
      targets: [new targets.LambdaFunction(signUpFilterCheck.alias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    const weeklyDigestSchedulerRole = new iam.Role(this, 'WeeklyDigestSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    weeklyDigestSchedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [generateWeeklyDigests.alias.functionArn],
      })
    );
    grantScheduledJobFailuresSend(weeklyDigestSchedulerRole);

    new scheduler.CfnSchedule(this, 'WeeklyDigestGenerationSchedule', {
      description: 'Canonical weekly digest publication every Sunday at 10:00 AM America/New_York.',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      scheduleExpression: WEEKLY_DIGEST_CANONICAL_SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: WEEKLY_DIGEST_CANONICAL_PUBLISH_TIMEZONE,
      state: 'ENABLED',
      target: {
        arn: generateWeeklyDigests.alias.functionArn,
        roleArn: weeklyDigestSchedulerRole.roleArn,
        deadLetterConfig: { arn: scheduledJobFailuresQueue(this).queueArn },
      },
    });

    this.fetchProcessedCongressMembers = addProdFunction(
      'FetchProcessedCongressMembers',
      'fetchProcessedCongressMembers',
      {
        environment: {
          BUCKET_NAME: CONGRESS_MEMBER_STORE_BUCKET_NAME,
          STATS_TABLE_NAME: CONGRESS_MEMBER_STATS_TABLE_NAME,
          STATS_PRIMARY_KEY: CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
        },
        timeout: cdk.Duration.seconds(USER_API_DEFAULT_TIMEOUT_SECONDS),
      },
    ).alias;
    congressMemberStoreBucket.grantRead(this.fetchProcessedCongressMembers);
    congressMemberStatsTable.grantReadData(this.fetchProcessedCongressMembers);

    this.fetchCongressMembersManifest = addProdFunction(
      'FetchCongressMembersManifest',
      'fetchCongressMembersManifest',
      {
        environment: {
          TABLE_NAME: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
          PRIMARY_KEY: CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY,
          STATS_TABLE_NAME: CONGRESS_MEMBER_STATS_TABLE_NAME,
          STATS_PRIMARY_KEY: CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
        },
        memorySize: 512,
        timeout: cdk.Duration.seconds(30),
      },
    ).alias;
    congressMembersManifestTable.grantReadData(this.fetchCongressMembersManifest);
    congressMemberStatsTable.grantReadData(this.fetchCongressMembersManifest);

    // ── Bills manifest: API handler and S3 snapshot (CAP-01) ────────────────

    // Derived data: PublishBillsManifest rewrites the one object from DynamoDB every 10 minutes, so
    // there is no versioning. SSE-S3, not KMS: FetchBillsManifest hands out presigned GETs, and a KMS
    // key would also need kms:Decrypt for every URL. Retained like the other buckets.
    const billsManifestSnapshotBucket = new s3.Bucket(this, 'BillsManifestSnapshotBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const billsManifestSnapshotObjectArn =
      billsManifestSnapshotBucket.arnForObjects(BILLS_MANIFEST_SNAPSHOT_KEY);
    // HeadObject on a missing key answers 403 instead of 404 without s3:ListBucket, so neither
    // handler could tell "no snapshot yet" from "access denied" (the publisher would never write the
    // first one). The bucket holds only the snapshot.
    const listSnapshotBucket = (): iam.PolicyStatement => new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [billsManifestSnapshotBucket.bucketArn],
    });
    // FetchBillsManifest (inline answers) and PublishBillsManifest must build the same manifest.
    const billsManifestSourceEnvironment = {
      TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
      PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
      PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
      PRIORITY_TABLE_NAME: props.billPriorityTable.tableName,
      PRIORITY_TABLE_PARTITION_KEY: BILL_PRIORITY_TABLE_PARTITION_KEY,
      PRIORITY_ACTIVE_INDEX_NAME: BILL_PRIORITY_ACTIVE_INDEX_NAME,
      PRIORITY_STATUS_ATTRIBUTE: BILL_PRIORITY_STATUS_ATTRIBUTE,
      PRIORITY_SORT_KEY_ATTRIBUTE: BILL_PRIORITY_SORT_KEY_ATTRIBUTE,
      PRIORITY_ACTIVE_STATUS_VALUE: BILL_PRIORITY_ACTIVE_STATUS,
    };
    const billsManifestSnapshotEnvironment = {
      MANIFEST_SNAPSHOT_BUCKET: billsManifestSnapshotBucket.bucketName,
      MANIFEST_SNAPSHOT_KEY: BILLS_MANIFEST_SNAPSHOT_KEY,
    };

    // APPF-23: FetchBillsManifest adds companionGroups to every inline answer from the groups row that
    // PublishBillsManifest writes; both read it through their manifest read grants.
    const fetchBillsManifest = addProdFunction('FetchBillsManifest', 'fetchBillsManifest', {
      environment: {
        ...billsManifestSourceEnvironment,
        ...billsManifestSnapshotEnvironment,
        ...BILL_COMPANION_ENVIRONMENT,
      },
      // Ran out of memory at 128 MB in production (2026-09-10). Kept: the inline answer remains.
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
    });
    props.billPriorityTable.grantReadData(fetchBillsManifest.fn);
    // HeadObject, and signing the presigned GET the client uses, need s3:GetObject on the snapshot.
    fetchBillsManifest.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [billsManifestSnapshotObjectArn],
      })
    );
    fetchBillsManifest.fn.addToRolePolicy(listSnapshotBucket());
    // No PutMetricData grant: SnapshotPointerServed and SnapshotPointerFallback are embedded-metric log lines.
    this.fetchBillsManifest = fetchBillsManifest.alias;
    billsManifestTable.grantReadData(this.fetchBillsManifest);

    const publishBillsManifest = addProdFunction('PublishBillsManifest', 'publishBillsManifest', {
      environment: {
        ...billsManifestSourceEnvironment,
        ...billsManifestSnapshotEnvironment,
        ...BILL_COMPANION_ENVIRONMENT,
        // The kill switch (see user-api-service-constants.ts). Only the publisher reads it; readers
        // follow the groups row it writes.
        COMPANION_GROUPS_ENABLED,
      },
      memorySize: PUBLISH_BILLS_MANIFEST_MEMORY_MB,
      timeout: cdk.Duration.seconds(PUBLISH_BILLS_MANIFEST_TIMEOUT_SECONDS),
    }, 'worker');
    props.billPriorityTable.grantReadData(publishBillsManifest.fn);
    // HeadObject for the current snapshot's hash, then PutObject when the bills changed.
    publishBillsManifest.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [billsManifestSnapshotObjectArn],
      })
    );
    publishBillsManifest.fn.addToRolePolicy(listSnapshotBucket());
    // SnapshotBillCount, SnapshotGzipBytes, SnapshotWritten and SnapshotUnchanged, and the APPF-23
    // Companion* metrics (CompanionResolveFailed has an alarm in MonitoringStack).
    grantCloudWatchMetricNamespaceWrite(publishBillsManifest.fn, BILLS_MANIFEST_METRIC_NAMESPACE);
    this.publishBillsManifest = publishBillsManifest.alias;
    // Also the companion reads: the Query of the BILL_COMPANION_DECL link lists and the groups row.
    billsManifestTable.grantReadData(this.publishBillsManifest);
    // APPF-23: its only store write, the versioned PutItem of the groups row (BILL_COMPANION_GROUPS).
    grantCompanionGroupsWrite(this, this.publishBillsManifest);
    // Scheduler's retry policy covers delivery only; Scheduler invokes asynchronously, so a function
    // error would otherwise get Lambda's default 2 retries over up to 6 hours. The next scheduled run
    // replaces a failed one, so none are needed.
    publishBillsManifest.alias.configureAsyncInvoke({ retryAttempts: 0 });

    const publishBillsManifestSchedulerRole = new iam.Role(this, 'PublishBillsManifestSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    publishBillsManifestSchedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [publishBillsManifest.alias.functionArn],
      })
    );
    grantScheduledJobFailuresSend(publishBillsManifestSchedulerRole);
    new scheduler.CfnSchedule(this, 'PublishBillsManifestSchedule', {
      description: 'Rewrites the bills manifest S3 snapshot every 10 minutes when the bills changed (CAP-01).',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      scheduleExpression: BILLS_MANIFEST_SNAPSHOT_SCHEDULE_EXPRESSION,
      state: 'ENABLED',
      target: {
        arn: publishBillsManifest.alias.functionArn,
        roleArn: publishBillsManifestSchedulerRole.roleArn,
        // A failed run gets no destination (the next run replaces it), but a delivery Scheduler cannot make
        // goes to ScheduledJobFailures: a message there means every run is failing to start, not one.
        deadLetterConfig: { arn: scheduledJobFailuresQueue(this).queueArn },
        retryPolicy: {
          maximumEventAgeInSeconds: BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_EVENT_AGE_SECONDS,
          maximumRetryAttempts: BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_RETRY_ATTEMPTS,
        },
      },
    });

    // ── API Gateway ──────────────────────────────────────────────────────────

    // 7B: the web ACL's two rate rules, on the API stage and the user pool.
    const gateway = new UserApiGateway(this, 'UserApiGateway', {
      userPool,
      signUpRateLimitAction: SIGNUP_RATE_LIMIT_ACTION,
    });
    this.userApi = gateway.api;
    this.addRoutes(gateway);

    // ── CloudWatch Synthetics canary ─────────────────────────────────────────

    const canary = new UserApiCanary(this, 'UserApiSmokeCanary', {
      api: this.userApi,
      userPoolClient: canaryUserPoolClient,
      smokeTestSecretName: props.smokeTestSecretName,
      smokeTestFixturesSecretName: props.smokeTestFixturesSecretName,
      smokeTestWriteChecksEnabled: props.smokeTestWriteChecksEnabled,
    });
    // Infra review item 15a: only the API handlers' groups. The canary calls API routes and never runs
    // the scheduled and queue workers (GenerateWeeklyDigests, WeeklyDigestWorker, CleanupOrphanedUsers,
    // ExportCognitoUsers, PublishBillsManifest, RestampUserVotes, SignUpFilterCheck). Its alarm treats missing data as "ignore" and the canary
    // only runs 13:00-23:45 UTC, so an evening ALARM state stays overnight, and on a worker group it
    // would stop or roll back an unrelated worker deploy. Each worker keeps its own alias error alarm.
    apiDeploymentGroups.forEach((deploymentGroup) => deploymentGroup.addAlarm(canary.alarm));

    // ── Outputs ──────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'UserApiUrl', {
      value: this.userApi.url,
      description: 'Base URL for the user API',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
    new cdk.CfnOutput(this, 'CognitoUserExportBucketName', {
      value: cognitoUserExportBucket.bucketName,
      description: 'Nightly Cognito user exports (cognito-users/YYYY-MM-DD.jsonl.gz)',
    });
    new cdk.CfnOutput(this, 'BillsManifestSnapshotBucketName', {
      value: billsManifestSnapshotBucket.bucketName,
      description: `Bills manifest snapshot written by PublishBillsManifest (${BILLS_MANIFEST_SNAPSHOT_KEY}, gzip JSON)`,
    });
  }

  // ── Routes (all integrations use the prod alias) ──────────────────────────
  // contracts/scripts/check-contracts.mjs reads the routes from this method and compares them
  // with the OpenAPI document. Keep one const per resource, assigned from addResource on its
  // parent, and add each method with addCognitoMethod, addPublicMethod or addMethod.
  private addRoutes(gateway: UserApiGateway): void {
    // Unauthenticated health check for CloudWatch Synthetics canary
    const health = this.userApi.root.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: { 'application/json': JSON.stringify({ status: 'ok' }) },
      }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      authorizationType: apigateway.AuthorizationType.NONE,
      methodResponses: [{ statusCode: '200' }],
    });

    const registerDevice = this.userApi.root.addResource('register-device');
    gateway.addCognitoMethod(registerDevice, 'POST', this.registerUserDevice, true);

    const deviceNotificationSettings = this.userApi.root.addResource('device-notification-settings');
    gateway.addCognitoMethod(deviceNotificationSettings, 'GET', this.deviceNotificationSettings);
    gateway.addCognitoMethod(deviceNotificationSettings, 'PUT', this.deviceNotificationSettings, true);

    const preferences = this.userApi.root.addResource('preferences');
    gateway.addCognitoMethod(preferences, 'GET', this.fetchPreferences);
    gateway.addCognitoMethod(preferences, 'PUT', this.setPreferences, true);
    gateway.addCognitoMethod(preferences, 'DELETE', this.deletePreferences);

    const me = this.userApi.root.addResource('me');
    gateway.addCognitoMethod(me, 'GET', this.fetchMe);

    const weeklyDigests = this.userApi.root.addResource('weekly-digests');
    const latestWeeklyDigest = weeklyDigests.addResource('latest');
    gateway.addCognitoMethod(latestWeeklyDigest, 'GET', this.fetchLatestWeeklyDigest);

    const adultAttestation = this.userApi.root.addResource('adult-attestation');
    gateway.addCognitoMethod(adultAttestation, 'POST', this.adultAttestation, true);

    const accountData = this.userApi.root.addResource('account-data');
    gateway.addCognitoMethod(accountData, 'DELETE', this.accountData);
    const accountDataStatus = accountData.addResource('status');
    gateway.addCognitoMethod(accountDataStatus, 'GET', this.accountDataStatus);

    const processedBill = this.userApi.root.addResource('processed-bill');
    gateway.addCognitoMethod(processedBill, 'GET', this.fetchProcessedBill);

    const publicResource = this.userApi.root.addResource('public');
    const publicProcessedBill = publicResource.addResource('processed-bill');
    const publicProcessedBillGetMethod = gateway.addPublicMethod(
      publicProcessedBill,
      'GET',
      this.fetchProcessedBill,
      { apiKeyRequired: true },
    );
    gateway.addSharePublicUsagePlan(publicProcessedBillGetMethod, this.sharePublicOriginApiKeyValue);

    const feedback = this.userApi.root.addResource('feedback');
    gateway.addCognitoMethod(feedback, 'GET', this.fetchFeedback);
    gateway.addCognitoMethod(feedback, 'POST', this.setFeedback, true);

    const feedbackBatch = this.userApi.root.addResource('feedback-batch');
    gateway.addCognitoMethod(feedbackBatch, 'POST', this.fetchFeedback, true);

    const billStats = this.userApi.root.addResource('bill-stats');
    gateway.addCognitoMethod(billStats, 'GET', this.fetchBillStats);

    const civicScore = this.userApi.root.addResource('civic-score');
    gateway.addCognitoMethod(civicScore, 'GET', this.fetchCivicScore);

    const civicProfile = this.userApi.root.addResource('civic-profile');
    gateway.addCognitoMethod(civicProfile, 'GET', this.fetchCivicProfile);

    const congressMemberCivicProfile =
      this.userApi.root.addResource('congress-member-civic-profile');
    gateway.addCognitoMethod(congressMemberCivicProfile, 'GET', this.fetchCongressMemberCivicProfile);

    const districtVerification = this.userApi.root.addResource('district-verification');
    gateway.addCognitoMethod(districtVerification, 'GET', this.districtVerification);
    gateway.addCognitoMethod(districtVerification, 'POST', this.districtVerification, true);

    const processedCongressMembers =
      this.userApi.root.addResource('processed-congress-members');
    gateway.addCognitoMethod(processedCongressMembers, 'GET', this.fetchProcessedCongressMembers);

    const congressMembersManifest =
      this.userApi.root.addResource('congress-members-manifest');
    gateway.addCognitoMethod(congressMembersManifest, 'GET', this.fetchCongressMembersManifest);

    const billsManifest = this.userApi.root.addResource('bills-manifest');
    gateway.addCognitoMethod(billsManifest, 'GET', this.fetchBillsManifest);

    // INT-04 (C3 3.2, 3.3): public, like /health: no authorizer and no API key, because sign-up and the first
    // attestation happen before sign-in. The handler validates the body itself (400, 413 above 16 KB).
    const appAttestResource = this.userApi.root.addResource('app-attest');
    const appAttestChallengeResource = appAttestResource.addResource('challenge');
    gateway.addPublicMethod(appAttestChallengeResource, 'POST', this.appAttest);
    const appAttestAttestResource = appAttestResource.addResource('attest');
    gateway.addPublicMethod(appAttestAttestResource, 'POST', this.appAttest);
    this.throttleStageMethod('/app-attest/challenge', 'POST', APP_ATTEST_CHALLENGE_THROTTLE);
    this.throttleStageMethod('/app-attest/attest', 'POST', APP_ATTEST_ATTEST_THROTTLE);
  }

  /**
   * Gives one method of the prod stage its own throttle (abuse-limits.ts explains why the App Attest routes
   * need one). A method setting replaces the stage-wide one for that method, so it repeats the stage's
   * logging, metrics and data-trace values. The stage is UserApiGateway's; this appends to its MethodSettings.
   */
  private throttleStageMethod(resourcePath: string, httpMethod: string, throttle: MethodThrottle): void {
    const stage = this.userApi.deploymentStage.node.defaultChild as apigateway.CfnStage;
    const settings = stage.methodSettings;
    const stageWide = Array.isArray(settings)
      ? (settings as apigateway.CfnStage.MethodSettingProperty[]).find(
        (setting) => setting.resourcePath === '/*' && setting.httpMethod === '*',
      )
      : undefined;
    if (!stageWide) {
      throw new Error('The prod stage has no stage-wide method setting to base the App Attest throttles on.');
    }
    stage.methodSettings = [
      ...(settings as apigateway.CfnStage.MethodSettingProperty[]),
      {
        // API Gateway's encoding, as CDK's own methodOptions write it: "/a/b" becomes "/~1a~1b".
        resourcePath: `/${resourcePath.replace(/\//g, '~1')}`,
        httpMethod,
        loggingLevel: stageWide.loggingLevel,
        metricsEnabled: stageWide.metricsEnabled,
        dataTraceEnabled: stageWide.dataTraceEnabled,
        throttlingRateLimit: throttle.rateLimit,
        throttlingBurstLimit: throttle.burstLimit,
      },
    ];
  }
}
