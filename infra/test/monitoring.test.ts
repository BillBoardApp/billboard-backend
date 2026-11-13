import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS } from "../lib/config/congress-integration-service-constants";
import { SCHEDULED_JOB_FAILURES_QUEUE_NAME } from "../lib/config/scheduled-jobs-constants";
import { BEDROCK_GRANTED_MODEL_IDS } from "../lib/config/bedrock-models";
import { APP_ATTEST_METRIC_NAMESPACE } from "../lib/config/app-attest-constants";
import {
  ACCOUNT_INTEGRITY_ALARM_THRESHOLDS,
  APP_ATTEST_ALARM_THRESHOLDS,
  APP_ATTEST_RESERVED_CONCURRENCY,
  VOTE_DAILY_CAP_ENFORCE_READY_MAX,
} from "../lib/config/abuse-limits";
import {
  CANARY_SIGN_IN_FAILED_METRIC_NAME,
  SIGNUP_FILTER_CHECK_METRIC_NAMESPACE,
} from "../lib/config/user-api-service-constants";
import { USER_API_CANARY_SCRIPT_PATH } from "../lib/constructs/user-api-canary";
import { ALARM_TOPIC_NAME, PAGE_TOPIC_NAME } from "../lib/stacks/helpers/alarm-topic";
import { APP_ATTEST_ALARM_NAMES } from "../lib/stacks/helpers/app-attest-alarms";
import {
  ACCOUNT_INTEGRITY_ALARM_NAMES,
  ACCOUNTS_METRIC_NAMESPACE,
  BEDROCK_METRIC_NAMESPACE,
  MONITORED_DLQ_NAMES,
  MONITORED_LAMBDA_NAMES,
  MONITORED_WORK_QUEUE_NAMES,
  MonitoringStack,
  PAGE_COMPOSITE_ALARM_NAMES,
  PAGE_MEMBER_ONLY_ALARM_NAMES,
  STATUS_ONLY_ALARM_NAMES,
  PIPELINE_METRIC_NAMESPACE,
  updatedBillsDeadLetterHorizon,
  QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS,
  SES_METRIC_NAMESPACE,
  SES_REPUTATION_ALARM_NAMES,
  SUSTAINED_THROTTLE_LAMBDA_NAMES,
  THROTTLE_MONITORED_LAMBDA_NAMES,
  UNCONFIRMED_SIGN_UP_SKIP_REASONS,
} from "../lib/stacks/monitoring";
import { cachedLookups } from "./helpers/synth-app";
import { synthesizeStacks } from "./helpers/synth-stacks";
import {
  DEPLOYMENT_ACCOUNT_ID,
  DEPLOYMENT_REGION,
  MONITORING_SLACK_CHANNEL_ID,
  MONITORING_SLACK_WORKSPACE_ID,
} from "../lib/config/deployment-identity";

const templates = synthesizeStacks();
const alarmTopicRef = { Ref: Match.stringLikeRegexp("^AlarmTopic") };

// Alarms that are not generated from one of the exported lists.
const STANDALONE_ALARM_NAMES = [
  "Billboard-API-5XXError",
  "Billboard-API-LatencyP99",
  "Billboard-Canary-SuccessPercent",
  "Billboard-Canary-SmokeSignInFailed",
  "Billboard-ProductHealth-WeeklyDigestAgeSeconds",
  "Billboard-Freshness-BillsManifestWriter",
  "Billboard-Freshness-CognitoUserExport",
  "Billboard-Freshness-BillsManifestSnapshot",
  // CB-07: routine.
  "Billboard-Freshness-SignUpFilterCheck",
  "Billboard-BillsManifest-CompanionResolveFailed",
  // INT-11: routine.
  "Billboard-BillStats-ResultsGateReadFailed",
  // UX-31: routine.
  "Billboard-Votes-EarlierVoteReadFailed",
  "Billboard-CivicScore-RecordFailed",
  "Billboard-Notifications-ApnsDeliveryFailures",
  "Billboard-Notifications-ApnsCertificateExpiry",
  "Billboard-WeeklyDigest-UsersFailed",
  // REL-45: replaced Billboard-Ingestion-BillXmlFetchFailure (routine).
  "Billboard-Ingestion-BillTextUnavailable",
  // REL-52: routine.
  "Billboard-Ingestion-SenateClassInferred",
  "Billboard-Ingestion-CongressApi429",
  "Billboard-Ingestion-CongressApiAuthFailure",
  "Billboard-Ingestion-BillPollerLag",
  // The heartbeat takes the lag alarm's missing-data job (30 minutes): routine, a member of Billboard-Ingest-Unhealthy.
  "Billboard-Heartbeat-BillsApiPoller",
  // REL-46: routine. The lag one goes when the 119th leaves POLL_TARGETS.
  "Billboard-Ingestion-BillPollerLag119",
  "Billboard-Ingestion-BillPollerStateMismatch",
  // REL-56: routine.
  "Billboard-Ingestion-BillPollerFilterImprecise",
  "Billboard-Ingestion-BillPollerPageDrift",
  "Billboard-Ingestion-BillPollerFallback",
  "Billboard-Ingestion-BillPollerLateRows",
  // REL-58: routine.
  "Billboard-Ingestion-FetchRawBillFailing",
  "Billboard-Bedrock-InvocationThrottles",
  "Billboard-Analytics-BillStatsAggregatorIteratorAge",
  "Billboard-Analytics-BillStatsAggregatorDuration",
  "Billboard-DynamoDB-PendingNotificationsTable-WriteThrottleEvents",
  // C1.2, C1.3, C1.8, C1.10: routine.
  "Billboard-Heartbeat-BillPriorityResolver",
  "Billboard-Notifications-ExpiredUndelivered",
  // UX-33: routine.
  "Billboard-Notifications-HeldPastLifetime",
  "Billboard-Pipeline-MessagesUnprocessable",
  "Billboard-Accounts-DeletionsStuck",
  // REL-53: routine.
  "Billboard-Accounts-UnconfirmedSignUpCleanupErrors",
  // LLM-11 and REL-40: routine.
  "Billboard-Bedrock-RequestRejected",
  "Billboard-Summarizer-FieldRepairRate",
  "Billboard-Priority-NoModelAnswer",
  // C1.4: page members with no action of their own.
  ...PAGE_MEMBER_ONLY_ALARM_NAMES,
  // C2 3.11: routine.
  ...ACCOUNT_INTEGRITY_ALARM_NAMES,
  // C3 3.11: routine.
  ...APP_ATTEST_ALARM_NAMES,
  // REL-54: routine.
  ...SES_REPUTATION_ALARM_NAMES,
];

// C1.4 and C1.9 removed these 28: 13 backlog, 13 DynamoDB SystemErrors and the 2 blind manifest ages.
const REMOVED_ALARM_NAME_PATTERNS = [
  /^Billboard-SQS-.*-Backlog$/,
  /^Billboard-DynamoDB-.*-SystemErrors$/,
  /^Billboard-ProductHealth-BillsManifestAgeSeconds$/,
  /^Billboard-ProductHealth-CongressMembersManifestAgeSeconds$/,
];

const expectedAlarmNames = (): string[] => [
  ...STANDALONE_ALARM_NAMES,
  ...MONITORED_LAMBDA_NAMES.map((name) => `Billboard-Lambda-${name}-Errors`),
  ...THROTTLE_MONITORED_LAMBDA_NAMES.map((name) => `Billboard-Lambda-${name}-Throttles`),
  ...MONITORED_WORK_QUEUE_NAMES.map((name) => `Billboard-SQS-${name}-OldestMessageAge`),
  ...MONITORED_DLQ_NAMES.map((name) => `Billboard-SQS-${name}-VisibleMessages`),
];

type CfnResource = { Properties: Record<string, any> };

const metricAlarms = (): Record<string, CfnResource> =>
  templates.monitoringTemplate.findResources("AWS::CloudWatch::Alarm") as Record<string, CfnResource>;

const compositeAlarms = (): Record<string, CfnResource> =>
  templates.monitoringTemplate.findResources("AWS::CloudWatch::CompositeAlarm") as Record<string, CfnResource>;

const alarmLogicalId = (alarmName: string): string => {
  const entry = Object.entries(metricAlarms()).find(([, resource]) => resource.Properties.AlarmName === alarmName);
  if (!entry) {
    throw new Error(`No alarm named ${alarmName}`);
  }
  return entry[0];
};

const compositeNamed = (alarmName: string): CfnResource => {
  const composite = Object.values(compositeAlarms()).find((resource) => resource.Properties.AlarmName === alarmName);
  if (!composite) {
    throw new Error(`No composite alarm named ${alarmName}`);
  }
  return composite;
};

// The logical IDs a composite's rule names, in the order written.
const ruleMemberIds = (composite: CfnResource): string[] =>
  [...JSON.stringify(composite.Properties.AlarmRule).matchAll(/"Fn::GetAtt":\["([^"]+)","Arn"\]/g)].map((match) => match[1]);

// Rebuilds the dashboard JSON from its Fn::Join, replacing each alarm ARN with "alarm:<logicalId>".
const dashboardBody = (template: Template): { widgets: Array<{ type: string; properties: Record<string, any> }> } => {
  const dashboards = template.findResources("AWS::CloudWatch::Dashboard") as Record<string, CfnResource>;
  const [, parts] = Object.values(dashboards)[0].Properties.DashboardBody["Fn::Join"] as [string, unknown[]];
  const text = parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const getAtt = (part as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"];
      return getAtt ? `alarm:${getAtt[0]}` : "token";
    })
    .join("");
  return JSON.parse(text);
};

// The markdown of the dashboard's text widgets (the section headers).
const sectionHeaders = (body: ReturnType<typeof dashboardBody>): string[] =>
  body.widgets.filter((widget) => widget.type === "text").map((widget) => String(widget.properties.markdown));

describe("MonitoringStack", () => {
  describe("alarm inventory", () => {
    test("creates exactly one alarm per monitored resource plus the standalone alarms", () => {
      const expected = expectedAlarmNames();
      const actual = Object.values(metricAlarms()).map((resource) => resource.Properties.AlarmName as string);

      expect([...actual].sort()).toEqual([...expected].sort());
      templates.monitoringTemplate.resourceCountIs("AWS::CloudWatch::Alarm", expected.length);
      templates.monitoringTemplate.resourceCountIs("AWS::CloudWatch::CompositeAlarm", 3);
    });

    // C1 section 10: 125 alarms at U9 (124 metric, 1 composite) less 28 removed, plus 8 metric alarms and
    // 2 composites: 104 and 3 after C1. C2 3.11 adds 10 metric alarms: the 6 Billboard-Integrity-*
    // alarms, Errors for PreSignUpCheck and RestampUserVotes, and RestampUserVotesDLQ's visible messages,
    // plus RestampUserVotesQueue's age (every queue is alarmed; see the coverage test). C3 3.11 adds 6: the 4
    // Billboard-AppAttest-* alarms and AppAttest's Errors and Throttles. LLM-11 adds 3: Bedrock-RequestRejected,
    // Summarizer-FieldRepairRate and Priority-NoModelAnswer. UA-04 adds 1: Canary-SmokeSignInFailed. CB-07 adds 3:
    // Integrity-SignUpFilterCheckFailed, Freshness-SignUpFilterCheck and SignUpFilterCheck's Errors. INT-11 adds 1:
    // BillStats-ResultsGateReadFailed. UX-31 adds 2: Votes-EarlierVoteReadFailed and CivicScore-RecordFailed.
    // REL-53 adds 1: Accounts-UnconfirmedSignUpCleanupErrors. REL-52 adds 1: Ingestion-SenateClassInferred. UX-33 adds
    // 1: Notifications-HeldPastLifetime. REL-54 adds 2: Email-BounceRate and Email-ComplaintRate. REL-46 adds 3:
    // Integrity-GeocoderVintageFallback, Ingestion-BillPollerLag119 and Ingestion-BillPollerStateMismatch.
    // The poller's heartbeat (Billboard-Heartbeat-BillsApiPoller) adds 1. REL-56 adds 4: Ingestion-BillPollerFilterImprecise,
    // Ingestion-BillPollerPageDrift, Ingestion-BillPollerFallback and Ingestion-BillPollerLateRows. REL-58 adds 1:
    // Ingestion-FetchRawBillFailing.
    test("MonitoringStack has 144 metric alarms and 3 composites", () => {
      expect(Object.keys(metricAlarms())).toHaveLength(144);
      expect(Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmName).sort()).toEqual([
        "Billboard-Ingest-Unhealthy",
        "Billboard-Page-AppBroken",
        "Billboard-Page-PushesDown",
      ]);
    });

    test("every alarm description fits CloudWatch's 1024-character limit", () => {
      Object.values({ ...metricAlarms(), ...compositeAlarms() }).forEach((resource) =>
        expect({ alarm: resource.Properties.AlarmName, tooLong: String(resource.Properties.AlarmDescription).length > 1024 })
          .toEqual({ alarm: resource.Properties.AlarmName, tooLong: false }),
      );
    });

    // An alarm that names a file sends on-call there: the file has to exist in the repository, and so in the public
    // copy. (That it holds what the text says is pinned where each alarm is tested, e.g. abuse-limits.ts below.)
    test("every repository file an alarm description or dashboard text names exists", () => {
      const repositoryRoot = path.join(__dirname, "..", "..");
      const texts = [
        ...Object.values({ ...metricAlarms(), ...compositeAlarms() }).map((resource) => String(resource.Properties.AlarmDescription)),
        ...dashboardBody(templates.monitoringTemplate).widgets.map((widget) => String(widget.properties.markdown ?? "")),
      ];
      const named = new Set(texts.flatMap((text) => text.match(/\b(?:infra|services)\/[A-Za-z0-9_./-]+\.(?:ts|js|md)\b/g) ?? []));
      expect(named.size).toBeGreaterThan(0);
      [...named].forEach((file) => expect({ file, exists: fs.existsSync(path.join(repositoryRoot, file)) }).toEqual({ file, exists: true }));
    });

    // The texts are public: they describe what a switch does in each mode, never where production is in the rollout
    // (a phase name) or which mode a switch ships in.
    test("no alarm description or dashboard text names a rollout phase or where a switch ships", () => {
      const texts = [
        ...Object.values({ ...metricAlarms(), ...compositeAlarms() }).map((resource) => String(resource.Properties.AlarmDescription)),
        ...dashboardBody(templates.monitoringTemplate).widgets.map((widget) => String(widget.properties.markdown ?? "")),
      ];
      const timeline = /\bPhases? [A-E]\b|\bC-(?:β|α|beta|alpha)\b|\bships? (?:in|as) (?:watch|plan|enforce)\b|\bverified accounts at\b/;
      expect(texts.filter((text) => timeline.test(text))).toEqual([]);
    });

    test("the 28 removed alarms are gone and the weekly digest age stays", () => {
      const names = Object.values(metricAlarms()).map((resource) => resource.Properties.AlarmName as string);
      REMOVED_ALARM_NAME_PATTERNS.forEach((pattern) =>
        expect({ pattern: String(pattern), found: names.filter((name) => pattern.test(name)) }).toEqual({
          pattern: String(pattern),
          found: [],
        }),
      );
      expect(names).toContain("Billboard-ProductHealth-WeeklyDigestAgeSeconds");
      expect(names).toContain(`Billboard-SQS-${SCHEDULED_JOB_FAILURES_QUEUE_NAME}-VisibleMessages`);
    });

    // C1.4: two tiers. Only the two page composites notify the page topic (on ALARM and on OK); the three
    // member-only alarms and the status-only composite have no action at all; everything else notifies only the
    // alarm topic, on ALARM.
    test("only the two page composites page; member-only and status-only alarms have no actions; the rest are routine", () => {
      expect(PAGE_COMPOSITE_ALARM_NAMES).toEqual(["Billboard-Page-AppBroken", "Billboard-Page-PushesDown"]);
      expect(STATUS_ONLY_ALARM_NAMES).toEqual(["Billboard-Ingest-Unhealthy"]);
      const alarms = { ...metricAlarms(), ...compositeAlarms() };
      Object.entries(alarms).forEach(([logicalId, resource]) => {
        const name = resource.Properties.AlarmName as string;
        const actions = {
          logicalId,
          alarm: resource.Properties.AlarmActions,
          ok: resource.Properties.OKActions,
          insufficientData: resource.Properties.InsufficientDataActions,
        };
        if (PAGE_COMPOSITE_ALARM_NAMES.includes(name)) {
          expect(actions).toEqual({
            logicalId,
            alarm: [{ Ref: expect.stringMatching(/^PageTopic/) }],
            ok: [{ Ref: expect.stringMatching(/^PageTopic/) }],
            insufficientData: undefined,
          });
        } else if (PAGE_MEMBER_ONLY_ALARM_NAMES.includes(name) || STATUS_ONLY_ALARM_NAMES.includes(name)) {
          expect(actions).toEqual({ logicalId, alarm: undefined, ok: undefined, insufficientData: undefined });
        } else {
          expect(actions).toEqual({
            logicalId,
            alarm: [{ Ref: expect.stringMatching(/^AlarmTopic/) }],
            ok: undefined,
            insufficientData: undefined,
          });
        }
      });
    });

    test("monitored lists cover the review's functions and DLQs without duplicates", () => {
      [
        MONITORED_LAMBDA_NAMES,
        THROTTLE_MONITORED_LAMBDA_NAMES,
        MONITORED_WORK_QUEUE_NAMES,
        MONITORED_DLQ_NAMES,
      ].forEach((list) => expect(new Set(list).size).toBe(list.length));

      expect(MONITORED_LAMBDA_NAMES).toHaveLength(48);
      expect(MONITORED_LAMBDA_NAMES).toEqual(expect.arrayContaining([
        "ExportCognitoUsers",
        "PublishBillsManifest",
        "NotificationFanout",
        "WeeklyDigestWorker",
      ]));
      expect(MONITORED_WORK_QUEUE_NAMES).toContain("notificationFanoutQueue");
      // The burst queue joined the other work queues once no queue had a backlog alarm (C1.4).
      expect(MONITORED_WORK_QUEUE_NAMES).toContain("WeeklyDigestQueue");
      expect(MONITORED_WORK_QUEUE_NAMES).toHaveLength(15);
      // C1.1: the scheduled jobs' failure queue is a DLQ although its name does not end in DLQ.
      expect(MONITORED_DLQ_NAMES).toContain(SCHEDULED_JOB_FAILURES_QUEUE_NAME);
      expect(MONITORED_DLQ_NAMES).toHaveLength(17);
      expect(MONITORED_DLQ_NAMES).toEqual(expect.arrayContaining([
        "NotificationTypeDLQ",
        "CongressMemberStatsDLQ",
        "userMatcherDLQ",
        "userNotifierDLQ",
        "BillsManifestDLQ",
        "CongressMembersManifestDLQ",
        "BillStatsAggregatorStreamDLQ",
        "notificationFanoutDLQ",
        "WeeklyDigestDLQ",
      ]));
      expect([...THROTTLE_MONITORED_LAMBDA_NAMES].sort()).toEqual(
        ["AppAttest", "BillSummarizer", "BillsApiPoller", "EnrichOfficialVotes", "FetchRawBill"],
      );
      THROTTLE_MONITORED_LAMBDA_NAMES.forEach((name) => expect(MONITORED_LAMBDA_NAMES).toContain(name));
    });

    test("drops the metric-math Lambda rollups and the aggregate DLQ alarm", () => {
      const names = Object.values(metricAlarms()).map((resource) => resource.Properties.AlarmName);
      expect(names).not.toContain("Billboard-Lambda-SingleFailure");
      expect(names).not.toContain("Billboard-Lambda-AsyncBatchSustainedFailures");
      expect(names).not.toContain("Billboard-SQS-AnyDLQVisible");
      expect(JSON.stringify(metricAlarms())).not.toContain("mTotal");
    });
  });

  describe("user API, canary and product health", () => {
    test("alarms on API Gateway 5XX errors in 2 of 3 minutes", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-API-5XXError",
        Namespace: "AWS/ApiGateway",
        MetricName: "5XXError",
        Dimensions: [{ Name: "ApiName", Value: "BillboardUserApi" }],
        Statistic: "Sum",
        Period: 60,
        Threshold: 5,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        TreatMissingData: "notBreaching",
      });
    });

    test("alarms on sustained API p99 latency above 3 seconds", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-API-LatencyP99",
        Namespace: "AWS/ApiGateway",
        MetricName: "Latency",
        Dimensions: [{ Name: "ApiName", Value: "BillboardUserApi" }],
        ExtendedStatistic: "p99",
        Period: 300,
        Threshold: 3000,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
      });
    });

    test("alarms when the canary success rate drops below 90%", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Canary-SuccessPercent",
        Namespace: "CloudWatchSynthetics",
        MetricName: "SuccessPercent",
        Dimensions: [{ Name: "CanaryName", Value: "billboard-api" }],
        Period: 900,
        Threshold: 90,
        ComparisonOperator: "LessThanThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        TreatMissingData: "notBreaching",
      });
    });

    // C1.9: the bills and congress members manifest ages read the API's generatedAt (the request time), so
    // their alarms could never fire; only the weekly digest age is left, unchanged.
    test("keeps the weekly digest freshness alarm, unchanged, and says it needs the smoke-test secret", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-ProductHealth-WeeklyDigestAgeSeconds",
        MetricName: "WeeklyDigestAgeSeconds",
        Namespace: "BillBoard/ProductHealth",
        Statistic: "Maximum",
        Period: 900,
        Threshold: 691200,
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: "Weekly digest freshness exceeded 8 days. Check the user API synthetic canary and manifest generation Lambda logs. Needs the canary smoke-test secret (userApiSmokeTestSecretName context): only the canary's authenticated steps emit this metric, so without the secret the alarm has no data and stays OK.",
      });
      expect(alarmLogicalId("Billboard-ProductHealth-WeeklyDigestAgeSeconds")).toMatch(/^WeeklyDigestFreshnessAlarm/);
      const productHealth = Object.values(metricAlarms())
        .filter((resource) => resource.Properties.Namespace === "BillBoard/ProductHealth")
        .map((resource) => resource.Properties.MetricName);
      expect(productHealth.sort()).toEqual([CANARY_SIGN_IN_FAILED_METRIC_NAME, "WeeklyDigestAgeSeconds"]);
    });

    // UA-04: a canary that cannot sign in (the secret or the test account is not as the script expects) skips its
    // signed-in steps and emits this metric instead of failing the run, so it must not page and must not stop a
    // deploy. The alarm is routine only: it is no member of Billboard-Page-AppBroken, and UserAPIServiceStack's
    // deployment groups name only the construct's SyntheticsCanaryAlarm, which lives in another stack.
    test("Billboard-Canary-SmokeSignInFailed is a routine alarm on the metric the canary script emits", () => {
      expect(CANARY_SIGN_IN_FAILED_METRIC_NAME).toBe("CanarySmokeSignInFailed");
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Canary-SmokeSignInFailed",
        Namespace: "BillBoard/ProductHealth",
        MetricName: CANARY_SIGN_IN_FAILED_METRIC_NAME,
        Statistic: "Sum",
        Period: 900,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
      const logicalId = alarmLogicalId("Billboard-Canary-SmokeSignInFailed");
      expect(metricAlarms()[logicalId].Properties.OKActions).toBeUndefined();

      // Not a page member, and not named by any composite.
      expect(PAGE_MEMBER_ONLY_ALARM_NAMES).not.toContain("Billboard-Canary-SmokeSignInFailed");
      Object.values(compositeAlarms()).forEach((composite) =>
        expect({ composite: composite.Properties.AlarmName, members: ruleMemberIds(composite) }).toEqual({
          composite: composite.Properties.AlarmName,
          members: expect.not.arrayContaining([logicalId]),
        }),
      );
      expect(ruleMemberIds(compositeNamed("Billboard-Page-AppBroken"))).toHaveLength(3);

      // The script emits exactly this name into this namespace.
      const script = fs.readFileSync(USER_API_CANARY_SCRIPT_PATH, "utf8");
      expect(script).toContain(`const SIGN_IN_FAILED_METRIC = '${CANARY_SIGN_IN_FAILED_METRIC_NAME}';`);
      expect(script).toContain("Namespace: 'BillBoard/ProductHealth'");
    });

    test("no CodeDeploy deployment group watches the sign-in alarm", () => {
      const userApi = templates.userApiTemplate;
      // The metric name is also inside the canary's inline script, so look at alarms and deployment groups only.
      expect(JSON.stringify(userApi.findResources("AWS::CloudWatch::Alarm"))).not.toContain(CANARY_SIGN_IN_FAILED_METRIC_NAME);
      const groups = Object.values(userApi.findResources("AWS::CodeDeploy::DeploymentGroup")) as CfnResource[];
      expect(groups.length).toBeGreaterThan(0);
      groups.forEach((group) => {
        const watched = JSON.stringify(group.Properties.AlarmConfiguration?.Alarms ?? []);
        expect(watched).not.toContain("SmokeSignInFailed");
        // MonitoringStack's alarms are not imported into the API stack.
        expect(watched).not.toContain("ImportValue");
      });
    });

    test("alarms when CreateBillsManifest has not run for 3 days", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-BillsManifestWriter",
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: "FILL(m, 0)", ReturnData: true }),
          Match.objectLike({
            Id: "m",
            MetricStat: Match.objectLike({
              Metric: Match.objectLike({
                Namespace: "AWS/Lambda",
                MetricName: "Invocations",
                Dimensions: [{ Name: "FunctionName", Value: "CreateBillsManifest" }],
              }),
              Period: 86400,
              Stat: "Sum",
            }),
          }),
        ]),
        Threshold: 0,
        ComparisonOperator: "LessThanOrEqualToThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
        TreatMissingData: "breaching",
      });
    });

    test("alarms when ExportCognitoUsers has not completed a run for 26 hours", () => {
      const lambdaMetric = (id: string, metricName: string) =>
        Match.objectLike({
          Id: id,
          ReturnData: false,
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({
              Namespace: "AWS/Lambda",
              MetricName: metricName,
              Dimensions: [{ Name: "FunctionName", Value: "ExportCognitoUsers" }],
            }),
            Period: 3600,
            Stat: "Sum",
          }),
        });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-CognitoUserExport",
        // A successful run is an invocation without an error; retried failures cancel out.
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: "FILL(invocations, 0) - FILL(errors, 0)", ReturnData: true }),
          lambdaMetric("invocations", "Invocations"),
          lambdaMetric("errors", "Errors"),
        ]),
        Threshold: 0,
        ComparisonOperator: "LessThanOrEqualToThreshold",
        EvaluationPeriods: 26,
        DatapointsToAlarm: 26,
        TreatMissingData: "breaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("alarms on APNs delivery failures for the production platform application", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Notifications-ApnsDeliveryFailures",
        Namespace: "AWS/SNS",
        MetricName: "NumberOfNotificationsFailed",
        Dimensions: Match.arrayEquals([
          { Name: "Application", Value: "BillboardApnsProduction" },
          { Name: "Platform", Value: "APNS" },
        ]),
        Statistic: "Sum",
        Period: 300,
        Threshold: 5,
      });
    });

    test("alarms 30 days before the APNs certificate expires", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Notifications-ApnsCertificateExpiry",
        Namespace: "BillBoard/Notifications",
        MetricName: "ApnsCertificateDaysRemaining",
        Dimensions: Match.absent(),
        Statistic: "Minimum",
        Threshold: 30,
        ComparisonOperator: "LessThanThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    test("alarms when the weekly digest fails for any user and points at the worker and its DLQ", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-WeeklyDigest-UsersFailed",
        Namespace: "BillBoard/WeeklyDigest",
        MetricName: "WeeklyDigestUsersFailed",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("/aws/lambda/WeeklyDigestWorker.*WeeklyDigestDLQ"),
        AlarmActions: [alarmTopicRef],
      });
    });

    // CAP-01: PublishBillsManifest emits SnapshotBillCount on every run, written or unchanged.
    test("alarms when no bills manifest snapshot run completed in 30 minutes", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-BillsManifestSnapshot",
        Namespace: "BillBoard/BillsManifest",
        MetricName: "SnapshotBillCount",
        Dimensions: Match.absent(),
        Statistic: "SampleCount",
        Period: 1800,
        Threshold: 1,
        ComparisonOperator: "LessThanThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "breaching",
        AlarmDescription: Match.stringLikeRegexp("PublishBillsManifest"),
        AlarmActions: [alarmTopicRef],
      });
    });

    // APPF-23: PublishBillsManifest emits CompanionResolveFailed=1 (no dimensions) on a run whose
    // companion resolve failed, and keeps publishing; three 10-minute periods in a row is three runs.
    test("alarms when companion groups fail to resolve on 3 consecutive publish runs", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-BillsManifest-CompanionResolveFailed",
        Namespace: "BillBoard/BillsManifest",
        MetricName: "CompanionResolveFailed",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 600,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("PublishBillsManifest.*COMPANION_GROUPS_ENABLED"),
        AlarmActions: [alarmTopicRef],
      });
    });
  });

  // INT-11: the results gate answers 500 rather than throwing, so only its own metric shows a failed vote read.
  describe("results gate", () => {
    test("alarms on 1 ResultsGateReadFailed in 5 minutes, routine, with no dimensions", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-BillStats-ResultsGateReadFailed",
        Namespace: "BillBoard/BillStats",
        MetricName: "ResultsGateReadFailed",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("FetchBillStats.*BatchGetItem.*Do not roll FetchBillStats back without checking first.*RUNBOOK 17.4"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("is no rollback alarm: no deployment group watches it", () => {
      const groups = templates.userApiTemplate.findResources("AWS::CodeDeploy::DeploymentGroup");
      expect(Object.keys(groups).length).toBeGreaterThan(0);
      expect(JSON.stringify(groups)).not.toContain("ResultsGateReadFailed");
    });
  });

  // UX-31: SetFeedback's read of the earlier vote and FetchCivicScore's record answer 500 rather than throwing, so only
  // their own metrics show a failure (feature review follow-up F2).
  describe("Civic Score participation record", () => {
    test("alarms on 1 EarlierVoteReadFailed in 5 minutes, routine, with no dimensions", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Votes-EarlierVoteReadFailed",
        Namespace: "BillBoard/BillStats",
        MetricName: "EarlierVoteReadFailed",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("SetFeedback.*dynamodb:GetItem on UserFeedback.*RUNBOOK 19.6"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("alarms on 1 failed read or write of the Civic Score record in 5 minutes, routine", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-CivicScore-RecordFailed",
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: "FILL(readFailed, 0) + FILL(writeFailed, 0)", ReturnData: true }),
          Match.objectLike({
            Id: "readFailed",
            MetricStat: Match.objectLike({
              Metric: { Namespace: "BillBoard/CivicScore", MetricName: "CivicRecordReadFailed" },
              Period: 300,
              Stat: "Sum",
            }),
            ReturnData: false,
          }),
          Match.objectLike({
            Id: "writeFailed",
            MetricStat: Match.objectLike({
              Metric: { Namespace: "BillBoard/CivicScore", MetricName: "CivicRecordWriteFailed" },
              Period: 300,
              Stat: "Sum",
            }),
            ReturnData: false,
          }),
        ]),
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("FetchCivicScore.*UserPII.*RUNBOOK 19.6"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the metrics are the ones the services emit, in those namespaces", () => {
      const handlers = path.join(__dirname, "..", "..", "services", "src", "handlers");
      const setFeedback = fs.readFileSync(path.join(handlers, "setFeedback", "index.ts"), "utf8");
      const fetchCivicScore = fs.readFileSync(path.join(handlers, "fetchCivicScore", "index.ts"), "utf8");
      expect(setFeedback).toContain('const RESULTS_METRIC_NAMESPACE = "BillBoard/BillStats";');
      expect(setFeedback).toContain('emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "EarlierVoteReadFailed", 1)');
      expect(fetchCivicScore).toContain('const CIVIC_SCORE_METRIC_NAMESPACE = "BillBoard/CivicScore";');
      ["CivicRecordReadFailed", "CivicRecordWriteFailed"].forEach((metricName) =>
        expect(fetchCivicScore).toContain(`emitEmbeddedMetric(CIVIC_SCORE_METRIC_NAMESPACE, "${metricName}", 1)`));
    });

    test("neither is a page, a page member or a rollback alarm", () => {
      const pageRules = JSON.stringify(Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmRule));
      const groups = JSON.stringify(templates.userApiTemplate.findResources("AWS::CodeDeploy::DeploymentGroup"));
      ["Billboard-Votes-EarlierVoteReadFailed", "Billboard-CivicScore-RecordFailed"].forEach((alarmName) => {
        expect(pageRules).not.toContain(`"${alarmLogicalId(alarmName)}"`);
        expect(groups).not.toContain(alarmName);
      });
    });
  });

  describe("ingestion", () => {
    // REL-45: bills left without text, 3 in 3 hours, instead of any single failed request on congress.gov.
    test("alarms on BillTextUnavailable (no dimensions), 3 or more in one 3-hour period, routine", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-BillTextUnavailable",
        MetricName: "BillTextUnavailable",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 10800,
        Threshold: 3,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        OKActions: Match.absent(),
        AlarmDescription: Match.stringLikeRegexp("FetchRawBill.*GovInfo.*RUNBOOK 4\\.10"),
      });
    });

    test("no alarm watches the per-source BillXmlFetchFailure or BillXmlFetchRefused series", () => {
      const watching = Object.values(metricAlarms())
        .filter((resource) => /BillXmlFetch(Failure|Refused)/.test(JSON.stringify(resource.Properties)))
        .map((resource) => resource.Properties.AlarmName);
      expect(watching).toEqual([]);
      const names = Object.values(metricAlarms()).map((resource) => resource.Properties.AlarmName);
      expect(names).not.toContain("Billboard-Ingestion-BillXmlFetchFailure");
    });

    // REL-52: a current senator's terms merged by an inferred Senate class, one weekly members refresh an hour.
    test("alarms on 1 SenateClassInferred in an hour (no dimensions), routine, outside Billboard-Ingest-Unhealthy", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-SenateClassInferred",
        MetricName: "SenateClassInferred",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 3600,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        // not_listed is a new senator, or one who has left while congress.gov still marks them current.
        AlarmDescription: Match.stringLikeRegexp(
          "CongressMemberSummarizer.*senators_cfm\\.xml.*a new senator" +
            ".*has left whom congress\\.gov still marks current.*RUNBOOK 21\\.2.*reprocess:congress-members, 21\\.5",
        ),
      });
      const pageAndCompositeRules = JSON.stringify(
        Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmRule),
      );
      expect(pageAndCompositeRules).not.toContain(`"${alarmLogicalId("Billboard-Ingestion-SenateClassInferred")}"`);
    });

    test("SenateClassInferred is the metric CongressMemberSummarizer emits, in that namespace", () => {
      const summarizer = fs.readFileSync(
        path.join(__dirname, "..", "..", "services", "src", "handlers", "congressMemberSummarizer", "index.ts"),
        "utf8",
      );
      expect(summarizer).toContain('const INGESTION_METRIC_NAMESPACE = "BillBoard/BillIngestion";');
      expect(summarizer).toMatch(/emitEmbeddedMetric\(INGESTION_METRIC_NAMESPACE, "SenateClassInferred", 1/);
    });

    test("alarms on sustained Congress API 429s", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-CongressApi429",
        MetricName: "CongressApi429",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        AlarmDescription: Match.stringLikeRegexp("429"),
      });
    });

    test("alarms on any Congress API auth failure", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-CongressApiAuthFailure",
        MetricName: "CongressApiAuthFailure",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    test("alarms when the poller reports an hour of lag, and stays in ALARM for 3 hours", () => {
      expect(BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS).toBe(3600);
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-BillPollerLag",
        MetricName: "BillPollerLagSeconds",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Maximum",
        Period: 900,
        Threshold: BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 12,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
      // The lag counts from the last run that polled, so a congress.gov outage reaches it only after an hour.
      const description = metricAlarms()[alarmLogicalId("Billboard-Ingestion-BillPollerLag")].Properties.AlarmDescription;
      expect(description).toMatch(/60 minutes or more/);
      expect(description).toMatch(/last run that met no outage/);
      expect(description).toMatch(/CongressApiUnavailable.*RUNBOOK 6\.2/);
      expect(description).toMatch(/RUNBOOK 6\.1/);
      // One notification per outage: 12 windows of 15 minutes hold it in ALARM for 3 hours.
      expect(description).toMatch(/3 hours/);
      // Missing datapoints are the heartbeat's job.
      expect(description).toMatch(/Billboard-Heartbeat-BillsApiPoller/);
    });

    test("heartbeat alarms when the poller emits no lag datapoint for 30 minutes", () => {
      const heartbeat = metricAlarms()[alarmLogicalId("Billboard-Heartbeat-BillsApiPoller")];
      expect(heartbeat).toBeDefined();
      const properties = heartbeat.Properties;
      expect(properties.EvaluationPeriods).toBe(2);
      expect(properties.DatapointsToAlarm).toBe(2);
      expect(properties.Threshold).toBe(0);
      expect(properties.ComparisonOperator).toBe("LessThanOrEqualToThreshold");
      expect(properties.TreatMissingData).toBe("breaching");
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Heartbeat-BillsApiPoller",
        AlarmActions: [alarmTopicRef],
      });
      const queries = properties.Metrics as Array<Record<string, any>>;
      const expression = queries.find((query) => query.Expression);
      expect(expression?.Expression).toBe("FILL(lagSamples, 0)");
      const samples = queries.find((query) => query.MetricStat)?.MetricStat;
      expect(samples.Metric.MetricName).toBe("BillPollerLagSeconds");
      expect(samples.Metric.Namespace).toBe("BillBoard/BillIngestion");
      expect(samples.Metric.Dimensions).toBeUndefined();
      expect(samples.Stat).toBe("SampleCount");
      expect(samples.Period).toBe(900);
      // The newest Congress failing or skipped leaves no lag, while the runs succeed.
      const description = properties.AlarmDescription;
      expect(description).toMatch(/30 minutes/);
      expect(description).toMatch(/BillPollerTargetError or BillPollerStateMismatch.*RUNBOOK 6\.3, 24\.2/);
      expect(description).toMatch(/RUNBOOK 4\.1/);
      expect(description).toMatch(/RUNBOOK 6\.1/);
    });

    // REL-46: the trailing 119th is polled after the 120th, outcomes only. Its own lag, or no datapoint, for 3 hours.
    test("alarms when the 119th has not been polled for 3 hours, until it leaves POLL_TARGETS", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-BillPollerLag119",
        MetricName: "BillPollerLagSeconds",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: [{ Name: "Congress", Value: "119" }],
        Statistic: "Maximum",
        Period: 10800,
        Threshold: 10800,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "breaching",
        AlarmActions: [alarmTopicRef],
        AlarmDescription: Match.stringLikeRegexp(
          "119th.*BillPollerTargetError.*RUNBOOK 6\\.3.*follows Billboard-Ingestion-BillPollerLag.*RUNBOOK 6\\.2",
        ),
      });
    });

    test("alarms on any BillPollerStateMismatch (no dimensions)", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-BillPollerStateMismatch",
        MetricName: "BillPollerStateMismatch",
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        AlarmDescription: Match.stringLikeRegexp("another congress.*never writes.*RUNBOOK 6\\.3"),
      });
    });

    // REL-56: congress.gov's list filter not working below an hour or a day (the hourly check), a list that moved while
    // it was read, the unfiltered fallback, and bills that showed in the list too late for their window.
    test.each([
      [
        "Billboard-Ingestion-BillPollerFilterImprecise",
        "BillPollerFilterImprecise",
        "below an hour or a day.*no pagination.count.*RUNBOOK 6\\.1",
      ],
      ["Billboard-Ingestion-BillPollerPageDrift", "BillPollerPageDrift", "25 rows.*fewer rows than.*RUNBOOK 6\\.1"],
      ["Billboard-Ingestion-BillPollerFallback", "BillPollerFallbackTypeCount", "rejected fromDateTime.*RUNBOOK 6\\.1"],
      ["Billboard-Ingestion-BillPollerLateRows", "BillPollerLateRows", "more than 120 s.*RUNBOOK 6\\.1"],
    ])("alarms on any %s in an hour (no dimensions)", (alarmName, metricName, description) => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName,
        MetricName: metricName,
        Namespace: "BillBoard/BillIngestion",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 3600,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        AlarmDescription: Match.stringLikeRegexp(description),
      });
    });

    test("has no alarm on CongressApiUnavailable itself: the lag is the user-impact signal", () => {
      const watchedMetricNames = (properties: Record<string, any>): string[] => [
        properties.MetricName,
        ...((properties.Metrics ?? []) as Array<{ MetricStat?: { Metric: { MetricName: string } } }>).map(
          (query) => query.MetricStat?.Metric.MetricName,
        ),
      ];
      const names = Object.values(metricAlarms())
        .filter((resource) => watchedMetricNames(resource.Properties).includes("CongressApiUnavailable"))
        .map((resource) => resource.Properties.AlarmName);
      // REL-58's alarm reads it only to stay quiet while the poller sees the outage too (the lag alarm's job).
      expect(names).toEqual(["Billboard-Ingestion-FetchRawBillFailing"]);
    });

    // REL-58: a bill on FetchRawBill's retry ladder rides it about 6 hours before UpdatedBillsDLQ, and SQS leaves it
    // out of the queue's age after its 3rd receive. This catches what the poller does not see: a failure that is not
    // congress.gov's, or a bill failing on congress.gov for 30 minutes while the poller met no outage.
    test("alarms when FetchRawBill fails a bill for a reason not congress.gov's, or for 30 minutes while the poller is fine", () => {
      const alarm = metricAlarms()[alarmLogicalId("Billboard-Ingestion-FetchRawBillFailing")].Properties;
      expect(alarm).toMatchObject({
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
      });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Ingestion-FetchRawBillFailing",
        AlarmActions: [alarmTopicRef],
      });
      const queries = alarm.Metrics as Array<Record<string, unknown>>;
      const expression = queries.find((query) => query.Expression);
      expect(expression).toMatchObject({
        Expression: "IF(FILL(other, 0) > 0 OR (FILL(failing, 0) >= 1800 AND FILL(pollerUnavailable, 0) == 0), 1, 0)",
        ReturnData: true,
      });
      const stats = Object.fromEntries(
        queries.filter((query) => query.MetricStat).map((query) => [query.Id, query.MetricStat]),
      );
      expect(stats).toEqual({
        other: {
          Metric: {
            Namespace: "BillBoard/BillIngestion",
            MetricName: "FetchRawBillRecordFailed",
            Dimensions: [{ Name: "Kind", Value: "other" }],
          },
          Period: 900,
          Stat: "Sum",
        },
        failing: {
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "FetchRawBillFailingSeconds" },
          Period: 900,
          Stat: "Maximum",
        },
        pollerUnavailable: {
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "CongressApiUnavailable" },
          Period: 900,
          Stat: "Sum",
        },
      });
      expect(alarm.AlarmDescription).toMatch(
        /Kind=other.*30 minutes or more.*met no outage.*about 6 hours.*Failed record will be retried.*RUNBOOK 6\.5/,
      );
      // Routine: no page composite names it.
      PAGE_COMPOSITE_ALARM_NAMES.forEach((name) =>
        expect(ruleMemberIds(compositeNamed(name))).not.toContain(alarmLogicalId("Billboard-Ingestion-FetchRawBillFailing")),
      );
    });

    // LLM-11: every ModelId form of every granted model, so a switch between granted models needs no alarm
    // change, and the callers' own count in case Bedrock reports a model under another form. Both count the
    // same throttles, so the larger is taken instead of the sum.
    test("alarms on Bedrock throttles for every granted model in every ModelId form, or as the callers count them", () => {
      const modelIdMetric = (id: string, value: unknown) =>
        Match.objectLike({
          Id: id,
          ReturnData: false,
          MetricStat: {
            Metric: {
              Namespace: "AWS/Bedrock",
              MetricName: "InvocationThrottles",
              Dimensions: [{ Name: "ModelId", Value: value }],
            },
            Period: 300,
            Stat: "Sum",
          },
        });
      const modelIdForms = BEDROCK_GRANTED_MODEL_IDS.flatMap((modelId) => [
        modelId,
        `us.${modelId}`,
        Match.objectLike({
          "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp(`inference-profile/us\\.${modelId.replace(/\./g, "\\.")}$`)])],
        }),
      ]);

      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Bedrock-InvocationThrottles",
        Metrics: [
          Match.objectLike({ Expression: "MAX([bedrock, callers])", ReturnData: true }),
          Match.objectLike({
            Id: "bedrock",
            Expression: `SUM([${modelIdForms.map((_, index) => `b${index}`).join(", ")}])`,
            ReturnData: false,
          }),
          ...modelIdForms.map((value, index) => modelIdMetric(`b${index}`, value)),
          Match.objectLike({
            Id: "callers",
            ReturnData: false,
            MetricStat: {
              Metric: { Namespace: BEDROCK_METRIC_NAMESPACE, MetricName: "BedrockThrottled" },
              Period: 300,
              Stat: "Sum",
            },
          }),
        ],
        Threshold: 5,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
      const description = metricAlarms()[alarmLogicalId("Billboard-Bedrock-InvocationThrottles")].Properties.AlarmDescription;
      BEDROCK_GRANTED_MODEL_IDS.forEach((modelId) => expect(description).toContain(modelId));
      expect(description).toContain("RUNBOOK 11.7");
    });

    // CAP-04: three quarters of the 60-second timeout.
    test("alarms when a bill stats aggregation batch runs longer than 45 seconds", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Analytics-BillStatsAggregatorDuration",
        Namespace: "AWS/Lambda",
        MetricName: "Duration",
        Dimensions: [{ Name: "FunctionName", Value: "BillStatsAggregator" }],
        Statistic: "Maximum",
        Period: 300,
        Threshold: 45000,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("alarms on DynamoDB stream iterator age for bill stats aggregation", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "IteratorAge",
        Namespace: "AWS/Lambda",
        Dimensions: [{ Name: "FunctionName", Value: "BillStatsAggregator" }],
        Threshold: 600000,
      });
    });

    test("composite ingest alarm fires on any of poller lag, poller heartbeat, the two ingest DLQs and Bedrock rejections, not on missing text", () => {
      const composites = templates.monitoringTemplate.findResources("AWS::CloudWatch::CompositeAlarm", {
        Properties: { AlarmName: "Billboard-Ingest-Unhealthy" },
      }) as Record<string, CfnResource>;
      const [composite] = Object.values(composites);
      expect(composite).toBeDefined();

      const rule = JSON.stringify(composite.Properties.AlarmRule);
      [
        "Billboard-Ingestion-BillPollerLag",
        "Billboard-Heartbeat-BillsApiPoller",
        "Billboard-SQS-UpdatedBillsDLQ-VisibleMessages",
        "Billboard-SQS-BillSummarizerDLQ-VisibleMessages",
        "Billboard-Bedrock-RequestRejected",
      ].forEach((alarmName) => expect(rule).toContain(`"${alarmLogicalId(alarmName)}"`));
      expect(rule.match(/ALARM\(/g)).toHaveLength(5);
      expect(rule.match(/ OR /g)).toHaveLength(4);
      // REL-45: missing text is not a member (ingestion keeps flowing).
      expect(rule).not.toContain(`"${alarmLogicalId("Billboard-Ingestion-BillTextUnavailable")}"`);
      // A status view only: each member notifies the alarm topic itself, so the composite's own notification only
      // repeated one (the action test above checks every member's).
      expect(composite.Properties.AlarmActions).toBeUndefined();
      expect(composite.Properties.OKActions).toBeUndefined();
      expect(composite.Properties.AlarmDescription).toMatch(/no notification of its own: each member notifies itself/);
      expect(composite.Properties.AlarmDescription).toMatch(/Bedrock rejecting/);
      expect(composite.Properties.AlarmDescription).not.toMatch(/bill XML fetch failures/);
      // A congress.gov outage reaches it only through the lag, after an hour; a poller that stops running reaches it
      // through the heartbeat; the poller's Errors and Throttles alarms are not members.
      expect(composite.Properties.AlarmDescription).toMatch(/no poll of congress\.gov for an hour/);
      expect(composite.Properties.AlarmDescription).toMatch(/heartbeat/);
      ["Billboard-Lambda-BillsApiPoller-Errors", "Billboard-Lambda-BillsApiPoller-Throttles"].forEach((alarmName) =>
        expect(rule).not.toContain(`"${alarmLogicalId(alarmName)}"`),
      );
    });
  });

  describe("Lambda", () => {
    test("one Errors alarm per function that names the function", () => {
      MONITORED_LAMBDA_NAMES.forEach((functionName) => {
        templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `Billboard-Lambda-${functionName}-Errors`,
          Namespace: "AWS/Lambda",
          MetricName: "Errors",
          Dimensions: [{ Name: "FunctionName", Value: functionName }],
          Statistic: "Sum",
          Period: 300,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          EvaluationPeriods: 3,
          DatapointsToAlarm: 2,
          TreatMissingData: "notBreaching",
          AlarmActions: [alarmTopicRef],
        });
      });
    });

    test("throttle alarms on the reserved-concurrency functions, 2 of 3 windows unless sustained throttling is required", () => {
      THROTTLE_MONITORED_LAMBDA_NAMES.forEach((functionName) => {
        templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `Billboard-Lambda-${functionName}-Throttles`,
          Namespace: "AWS/Lambda",
          MetricName: "Throttles",
          Dimensions: [{ Name: "FunctionName", Value: functionName }],
          Statistic: "Sum",
          Period: 300,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          EvaluationPeriods: 3,
          DatapointsToAlarm: SUSTAINED_THROTTLE_LAMBDA_NAMES.includes(functionName) ? 3 : 2,
          TreatMissingData: "notBreaching",
          AlarmActions: [alarmTopicRef],
        });
      });
    });

    // One overlap at reserved concurrency 1 (an async retry or a slow run meeting the next scheduled run) lasts at most
    // the 120-second timeout, so it can straddle 2 five-minute windows but never 3: six throttles at 18:08Z on
    // 2026-10-27 fired the 2-of-3 alarm twice.
    test("the BillsApiPoller throttle alarm fires only on throttles in each of 3 five-minute windows", () => {
      expect(SUSTAINED_THROTTLE_LAMBDA_NAMES).toEqual(["BillsApiPoller"]);
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Lambda-BillsApiPoller-Throttles",
        Period: 300,
        Threshold: 1,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
      });
      const description = metricAlarms()[alarmLogicalId("Billboard-Lambda-BillsApiPoller-Throttles")].Properties.AlarmDescription;
      expect(description).toMatch(/each of the last 3 five-minute windows/);
      expect(description).toMatch(/One overlap .* does not fire this/);
      expect(description).toMatch(/RUNBOOK 6\.1/);
    });

    // Real errors still fire it: an outage no longer fails a run, so the 2-of-3 rule stays.
    test("the BillsApiPoller Errors alarm keeps its 2-of-3 rule", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Lambda-BillsApiPoller-Errors",
        MetricName: "Errors",
        Dimensions: [{ Name: "FunctionName", Value: "BillsApiPoller" }],
        Period: 300,
        Threshold: 1,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
      });
    });
  });

  describe("queues", () => {
    // C1.4: a bulk rerun would flood the channel with backlog alarms; the age and DLQ alarms remain.
    test("no queue has a backlog-count alarm", () => {
      const visibleCountAlarms = Object.values(metricAlarms())
        .filter((resource) => resource.Properties.MetricName === "ApproximateNumberOfMessagesVisible")
        .map((resource) => resource.Properties.AlarmName as string);
      expect(visibleCountAlarms.sort()).toEqual(
        MONITORED_DLQ_NAMES.map((name) => `Billboard-SQS-${name}-VisibleMessages`).sort(),
      );
    });

    test("alarms when work queue ages grow, after 10 minutes for the notification fan-out and an hour for UpdatedBillsQueue", () => {
      expect(QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS).toEqual({ notificationFanoutQueue: 600, UpdatedBillsQueue: 3600 });
      MONITORED_WORK_QUEUE_NAMES.forEach((queueName) => {
        const threshold = { notificationFanoutQueue: 600, UpdatedBillsQueue: 3600 }[queueName] ?? 1200;
        templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `Billboard-SQS-${queueName}-OldestMessageAge`,
          MetricName: "ApproximateAgeOfOldestMessage",
          Namespace: "AWS/SQS",
          Dimensions: [{ Name: "QueueName", Value: queueName }],
          Threshold: threshold,
          AlarmDescription: Match.stringLikeRegexp(`exceeded ${threshold / 60} minutes`),
          AlarmActions: [alarmTopicRef],
        });
      });
    });

    // Moving WeeklyDigestQueue into the work-queue list must not replace its age alarm.
    test("the weekly digest queue keeps its age alarm and its logical ID", () => {
      expect(alarmLogicalId("Billboard-SQS-WeeklyDigestQueue-OldestMessageAge")).toMatch(/^WeeklyDigestQueueQueueAgeAlarm[0-9A-F]{8}$/);
      Object.values(metricAlarms())
        .filter((resource) => /-OldestMessageAge$/.test(resource.Properties.AlarmName))
        .forEach((resource) => {
          const queueName = resource.Properties.Dimensions[0].Value as string;
          expect(alarmLogicalId(resource.Properties.AlarmName)).toMatch(new RegExp(`^${queueName}QueueAgeAlarm`));
        });
    });

    test("alarms on one visible message in every DLQ", () => {
      MONITORED_DLQ_NAMES.forEach((queueName) => {
        templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `Billboard-SQS-${queueName}-VisibleMessages`,
          MetricName: "ApproximateNumberOfMessagesVisible",
          Namespace: "AWS/SQS",
          Dimensions: [{ Name: "QueueName", Value: queueName }],
          Threshold: 1,
          TreatMissingData: "notBreaching",
        });
      });
    });

    // UX-33 review (F4): a dead-lettered passed or failed message also holds its version's action push, so the two
    // pipeline DLQs before the fan-out say where to read the failure, to redrive within 24 hours and where the steps are.
    test.each([
      ["NotificationTypeDLQ", "/aws/lambda/NotificationType.*NotificationTypeQueue within 24 hours.*RUNBOOK 11\\.1"],
      [
        "userMatcherDLQ",
        "about 15 minutes.*action push.*voters and watchers.*/aws/lambda/UserMatcher.*userMatcherQueue within 24 hours" +
          ".*paired action's too, last 3 days.*purge.*RUNBOOK 11\\.1",
      ],
      // OBS-21: its bills stay unstored or stale until a redrive, and while it holds ALARM a new dead letter is silent.
      // REL-57: or stored but not yet diffed, which under REFETCH_UNCHANGED_MODE on a later equal listing does not heal.
      // REL-58: after about 6 hours of congress.gov failures on FetchRawBill's retry ladder, or about 11 minutes of
      // any other failure (and of a bulk message's).
      [
        "UpdatedBillsDLQ",
        "failed its 11 receives in FetchRawBill: about 6 hours of congress.gov timeouts, 5xx or 429s \\(retried after 3, 5, " +
          "10, 20 and 30 minutes, then hourly; RUNBOOK 6\\.5\\), or about 11 minutes of any other error or of a refetch or " +
          "backfill message's.*not stored at all, or is stored but not yet diffed" +
          ".*under REFETCH_UNCHANGED_MODE on a later listing that changes nothing does not send it on \\(RUNBOOK 6\\.4\\)" +
          ".*start-message-move-task \\(RUNBOOK 6\\.2\\).*a new dead letter sends no notification",
      ],
    ])("says how to redrive %s", (queueName, description) => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `Billboard-SQS-${queueName}-VisibleMessages`,
        AlarmDescription: Match.stringLikeRegexp(description),
      });
    });

    // REL-58: the UpdatedBillsDLQ text follows the switch, so a rollback (off, then 3 receives) does not leave it
    // promising 6 hours.
    test.each<["off" | "on", number, string]>([
      [
        "on",
        11,
        "about 6 hours of congress.gov timeouts, 5xx or 429s (retried after 3, 5, 10, 20 and 30 minutes, then hourly; " +
          "RUNBOOK 6.5), or about 11 minutes of any other error or of a refetch or backfill message's",
      ],
      ["off", 11, "about 33 minutes, 180 s apart (the retry ladder is off; RUNBOOK 6.5)"],
      ["off", 3, "about 9 minutes, 180 s apart (the retry ladder is off; RUNBOOK 6.5)"],
    ])("the UpdatedBillsDLQ text with the ladder %s and %d receives", (backoff, receives, text) => {
      expect(updatedBillsDeadLetterHorizon(backoff, receives)).toBe(text);
    });

    // C1.1: a record here is a failed scheduled job or an undeliverable schedule; the description says
    // where to read it and that the cleanup job must not be rerun blindly.
    test("alarms on one record in ScheduledJobFailures and says how to read it", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-SQS-ScheduledJobFailures-VisibleMessages",
        Namespace: "AWS/SQS",
        MetricName: "ApproximateNumberOfMessagesVisible",
        Dimensions: [{ Name: "QueueName", Value: "ScheduledJobFailures" }],
        Statistic: "Maximum",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("requestPayload.*ERROR_CODE.*14 days.*RUNBOOK 11\\.6.*CleanupOrphanedUsers"),
        AlarmActions: [alarmTopicRef],
      });
      // Its logical ID follows the DLQ pattern, like the other 15.
      expect(alarmLogicalId("Billboard-SQS-ScheduledJobFailures-VisibleMessages")).toMatch(/^ScheduledJobFailuresVisibleAlarm/);
    });
  });

  // CAP-02: the dedupe and dispatch marker partitions take every pending-notification write.
  test("alarms on sustained PendingNotifications write throttling", () => {
    templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "Billboard-DynamoDB-PendingNotificationsTable-WriteThrottleEvents",
      Namespace: "AWS/DynamoDB",
      MetricName: "WriteThrottleEvents",
      Dimensions: [{ Name: "TableName", Value: "PendingNotificationsTable" }],
      Statistic: "Sum",
      Period: 300,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      TreatMissingData: "notBreaching",
      AlarmActions: [alarmTopicRef],
    });
  });

  // C1.4: SDK retries absorb DynamoDB 5xx errors; a persistent one shows in the callers' alarms.
  test("no DynamoDB SystemErrors alarm or Metrics Insights query remains", () => {
    expect(JSON.stringify(metricAlarms())).not.toContain("SystemErrors");
    const dynamoAlarms = Object.values(metricAlarms())
      .filter((resource) => /^Billboard-DynamoDB-/.test(resource.Properties.AlarmName))
      .map((resource) => resource.Properties.AlarmName);
    expect(dynamoAlarms).toEqual(["Billboard-DynamoDB-PendingNotificationsTable-WriteThrottleEvents"]);
  });

  describe("cost", () => {
    test("creates a 75 USD monthly cost budget that notifies the alarm topic", () => {
      const notification = (notificationType: string, threshold: number) => ({
        Notification: {
          NotificationType: notificationType,
          ComparisonOperator: "GREATER_THAN",
          Threshold: threshold,
          ThresholdType: "PERCENTAGE",
        },
        Subscribers: [{ SubscriptionType: "SNS", Address: alarmTopicRef }],
      });

      templates.monitoringTemplate.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: {
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: 75, Unit: "USD" },
        },
        NotificationsWithSubscribers: Match.arrayEquals([
          notification("ACTUAL", 80),
          notification("FORECASTED", 100),
        ]),
      });
    });

    // Infra review item 7: in an organization's management account, a budget without the filter would also
    // count the linked accounts' spend.
    test("counts only the deploying account's spend", () => {
      const budgets = Object.values(templates.monitoringTemplate.findResources("AWS::Budgets::Budget"));
      expect(budgets).toHaveLength(1);
      // An environment-agnostic stack names its own account through the pseudo parameter.
      expect(budgets[0].Properties.Budget.CostFilters).toEqual({ LinkedAccount: [{ Ref: "AWS::AccountId" }] });
      // Only the filter was added: the limit, period, type and notifications are unchanged.
      expect(Object.keys(budgets[0].Properties.Budget).sort()).toEqual(
        ["BudgetLimit", "BudgetName", "BudgetType", "CostFilters", "TimeUnit"],
      );

      const envStack = new MonitoringStack(new cdk.App(), "MonitoringStack", {
        env: { account: DEPLOYMENT_ACCOUNT_ID, region: DEPLOYMENT_REGION },
      });
      Template.fromStack(envStack).hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({ CostFilters: { LinkedAccount: [DEPLOYMENT_ACCOUNT_ID] } }),
      });
    });

    test("lets Budgets and CloudWatch alarms publish to the alarm topic", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::SNS::TopicPolicy", {
        Topics: [alarmTopicRef],
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Principal: { Service: "cloudwatch.amazonaws.com" },
              Action: "sns:Publish",
            }),
            Match.objectLike({
              Effect: "Allow",
              Principal: { Service: "budgets.amazonaws.com" },
              Action: "sns:Publish",
              Condition: Match.objectLike({ StringEquals: { "aws:SourceAccount": Match.anyValue() } }),
            }),
          ]),
        },
      });
    });
  });

  describe("dashboard", () => {
    test("creates the BillboardOps dashboard", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: "BillboardOps",
      });
    });

    test("alarm status widgets show every alarm, at most 100 per widget", () => {
      const statusWidgets = dashboardBody(templates.monitoringTemplate).widgets.filter((widget) => widget.type === "alarm");
      statusWidgets.forEach((widget) => expect(widget.properties.alarms.length).toBeLessThanOrEqual(100));

      const shown = statusWidgets.flatMap((widget) => widget.properties.alarms as string[]).sort();
      const allAlarmIds = [
        ...Object.keys(metricAlarms()),
        ...Object.keys(templates.monitoringTemplate.findResources("AWS::CloudWatch::CompositeAlarm")),
      ].map((logicalId) => `alarm:${logicalId}`).sort();
      expect(shown).toEqual(allAlarmIds);
    });

    test("graphs the API, pipeline, queue and delivery metrics, including the previously ungraphed ones", () => {
      const body = JSON.stringify(dashboardBody(templates.monitoringTemplate));
      [
        // API
        "\"Count\"", "4XXError", "5XXError", "p99",
        // Pipeline
        "BillPollerLagSeconds", "CongressApiUnavailable", "BillsDiscovered", "BillsEnqueued", "BillXmlFetchFailure", "CongressApi429",
        "CongressApiAuthFailure", "InvocationThrottles", "InputTokenCount", "OutputTokenCount",
        "BillXmlFetchSuccess", "BillPollerMissingUpdateDate", "BillPollerFallbackTypeCount",
        // REL-56: the poller's filter check, page drift and late bills.
        "BillPollerFilterImprecise", "BillPollerPageDrift", "BillPollerLateRows",
        // REL-45: per-source requests and per-bill text outcomes.
        "BillXmlReused", "BillXmlFallbackUsed", "BillXmlSourceSkipped", "BillTextRetryScheduled", "BillTextUnavailable",
        "BillXmlFetchRefused",
        "HouseMemberVotesAttached", "SenateMemberVotesAttached", "EnrichmentDeferred", "EnrichmentPartialFinalized",
        // Delivery and freshness
        "NumberOfNotificationsDelivered", "NumberOfNotificationsFailed", "SuccessPercent",
        "WeeklyDigestAgeSeconds", "ApnsCertificateDaysRemaining",
      ].forEach((metricName) => expect(body).toContain(metricName));
      // C1.9: the two blind manifest ages are no longer graphed.
      expect(body).not.toContain("BillsManifestAgeSeconds");
      expect(body).not.toContain("CongressMembersManifestAgeSeconds");

      [...MONITORED_WORK_QUEUE_NAMES, ...MONITORED_DLQ_NAMES].forEach((queueName) =>
        expect(body).toContain(`"${queueName}"`)
      );
    });

    // C1.4: a "Pages" status widget first, with the two composites and their three member-only alarms;
    // the DynamoDB widget now holds only the write-throttle alarm.
    test("shows the pages first, then the routine groups, and renames the DynamoDB widget", () => {
      const statusWidgets = dashboardBody(templates.monitoringTemplate).widgets.filter((widget) => widget.type === "alarm");
      const [pages] = statusWidgets;
      expect(pages.properties.title).toMatch(/^Pages:/);
      const pageIds = [
        ...PAGE_COMPOSITE_ALARM_NAMES.map((name) =>
          Object.entries(compositeAlarms()).find(([, resource]) => resource.Properties.AlarmName === name)![0]),
        ...PAGE_MEMBER_ONLY_ALARM_NAMES.map(alarmLogicalId),
      ].map((logicalId) => `alarm:${logicalId}`);
      expect([...pages.properties.alarms].sort()).toEqual(pageIds.sort());

      const titles = statusWidgets.map((widget) => widget.properties.title as string);
      expect(titles).toContain("Alarms: DynamoDB throttles");
      expect(titles).not.toContain("Alarms: DynamoDB system errors");
      const dynamodb = statusWidgets.find((widget) => widget.properties.title === "Alarms: DynamoDB throttles")!;
      expect(dynamodb.properties.alarms).toEqual([
        `alarm:${alarmLogicalId("Billboard-DynamoDB-PendingNotificationsTable-WriteThrottleEvents")}`,
      ]);
    });
  });

  describe("pages (C1.4)", () => {
    test("Billboard-Page-AppBroken fires on the API 5XX, canary or snapshot-stale member", () => {
      const composite = compositeNamed("Billboard-Page-AppBroken");
      expect(ruleMemberIds(composite)).toEqual([
        alarmLogicalId("Billboard-API-5XXError"),
        alarmLogicalId("Billboard-Canary-SuccessPercent"),
        alarmLogicalId("Billboard-Page-BillsManifestSnapshotStale"),
      ]);
      const rule = JSON.stringify(composite.Properties.AlarmRule);
      expect(rule.match(/ALARM\(/g)).toHaveLength(3);
      expect(rule.match(/ OR /g)).toHaveLength(2);
      expect(composite.Properties.AlarmDescription).toMatch(/^PAGE: /);
    });

    test("Billboard-Page-PushesDown fires on the dispatcher heartbeat, APNs failures or a stalled NotificationTypeQueue", () => {
      const composite = compositeNamed("Billboard-Page-PushesDown");
      expect(ruleMemberIds(composite)).toEqual([
        alarmLogicalId("Billboard-Heartbeat-NotificationDispatcher"),
        alarmLogicalId("Billboard-Notifications-ApnsDeliveryFailures"),
        alarmLogicalId("Billboard-Page-NotificationTypeQueueStalled"),
      ]);
      const rule = JSON.stringify(composite.Properties.AlarmRule);
      expect(rule.match(/ALARM\(/g)).toHaveLength(3);
      expect(rule.match(/ OR /g)).toHaveLength(2);
      expect(composite.Properties.AlarmDescription).toMatch(/^PAGE: /);
    });

    test("the existing members keep their routine action", () => {
      ["Billboard-API-5XXError", "Billboard-Canary-SuccessPercent", "Billboard-Notifications-ApnsDeliveryFailures"]
        .forEach((alarmName) => {
          templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
            AlarmName: alarmName,
            AlarmActions: [alarmTopicRef],
          });
        });
    });

    test("the snapshot-stale member fires 2.5 hours after the last PublishBillsManifest run", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Page-BillsManifestSnapshotStale",
        Namespace: "BillBoard/BillsManifest",
        MetricName: "SnapshotBillCount",
        Dimensions: Match.absent(),
        Statistic: "SampleCount",
        Period: 1800,
        Threshold: 1,
        ComparisonOperator: "LessThanThreshold",
        EvaluationPeriods: 5,
        DatapointsToAlarm: 5,
        TreatMissingData: "breaching",
        AlarmActions: Match.absent(),
      });
      // The 30-minute routine freshness alarm stays as it was.
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-BillsManifestSnapshot",
        Period: 1800,
        EvaluationPeriods: 1,
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the NotificationType-stalled member fires when a message has waited 2 hours", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Page-NotificationTypeQueueStalled",
        Namespace: "AWS/SQS",
        MetricName: "ApproximateAgeOfOldestMessage",
        Dimensions: [{ Name: "QueueName", Value: "NotificationTypeQueue" }],
        Statistic: "Maximum",
        Period: 300,
        Threshold: 7200,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: Match.absent(),
      });
    });

    test("the page topic accepts only CloudWatch alarms of this account and region", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::SNS::Topic", { TopicName: PAGE_TOPIC_NAME });
      templates.monitoringTemplate.hasResourceProperties("AWS::SNS::Topic", { TopicName: ALARM_TOPIC_NAME });
      const policies = Object.values(templates.monitoringTemplate.findResources("AWS::SNS::TopicPolicy"))
        .filter((policy) => JSON.stringify(policy.Properties.Topics).includes("PageTopic"));
      expect(policies).toHaveLength(1);
      expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
        {
          Sid: "AllowCloudWatchAlarmsToPublish",
          Effect: "Allow",
          Principal: { Service: "cloudwatch.amazonaws.com" },
          Action: "sns:Publish",
          Resource: { Ref: expect.stringMatching(/^PageTopic/) },
          Condition: { ArnLike: { "aws:SourceArn": expect.objectContaining({ "Fn::Join": expect.anything() }) } },
        },
      ]);
      expect(JSON.stringify(policies[0].Properties.PolicyDocument)).toContain(":alarm:*");
    });
  });

  // C1.2: both copy the Cognito export alarm's shape: no successful run (invocations minus errors) for the
  // whole window, and missing data breaching.
  describe("heartbeats (C1.2)", () => {
    const successfulRuns = (functionName: string, period: number) => Match.arrayWith([
      Match.objectLike({ Expression: "FILL(invocations, 0) - FILL(errors, 0)", ReturnData: true }),
      ...["invocations", "errors"].map((id) => Match.objectLike({
        Id: id,
        ReturnData: false,
        MetricStat: Match.objectLike({
          Metric: Match.objectLike({
            Namespace: "AWS/Lambda",
            MetricName: id === "invocations" ? "Invocations" : "Errors",
            Dimensions: [{ Name: "FunctionName", Value: functionName }],
          }),
          Period: period,
          Stat: "Sum",
        }),
      })),
    ]);

    test("NotificationDispatcher: 30 minutes without a successful run, a page member with no action", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Heartbeat-NotificationDispatcher",
        Metrics: successfulRuns("NotificationDispatcher", 300),
        Threshold: 0,
        ComparisonOperator: "LessThanOrEqualToThreshold",
        EvaluationPeriods: 6,
        DatapointsToAlarm: 6,
        TreatMissingData: "breaching",
        AlarmActions: Match.absent(),
      });
    });

    test("BillPriorityResolver: 8 hours without a successful run (6 empty hours a night), routine", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Heartbeat-BillPriorityResolver",
        Metrics: successfulRuns("BillPriorityResolver", 3600),
        Threshold: 0,
        ComparisonOperator: "LessThanOrEqualToThreshold",
        EvaluationPeriods: 8,
        DatapointsToAlarm: 8,
        TreatMissingData: "breaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the Cognito export freshness alarm is unchanged", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-CognitoUserExport",
        Metrics: successfulRuns("ExportCognitoUsers", 3600),
        EvaluationPeriods: 26,
        DatapointsToAlarm: 26,
      });
    });
  });

  // C1.3, C1.8, C1.10, UX-33: one routine alarm each on a metric with no dimensions, over one day.
  describe("daily routine alarms on the new metrics", () => {
    test.each([
      ["Billboard-Notifications-ExpiredUndelivered", "BillBoard/Notifications", "NotificationsExpiredUndelivered", "Sum"],
      ["Billboard-Notifications-HeldPastLifetime", "BillBoard/Notifications", "NotificationsHeldPastLifetime", "Sum"],
      ["Billboard-Pipeline-MessagesUnprocessable", PIPELINE_METRIC_NAMESPACE, "MessagesUnprocessable", "Sum"],
      ["Billboard-Accounts-DeletionsStuck", ACCOUNTS_METRIC_NAMESPACE, "AccountDeletionsStuck", "Maximum"],
      ["Billboard-Accounts-UnconfirmedSignUpCleanupErrors", ACCOUNTS_METRIC_NAMESPACE, "UnconfirmedSignUpCleanupErrors", "Sum"],
    ])("%s", (alarmName, namespace, metricName, statistic) => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName,
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: Match.absent(),
        Statistic: statistic,
        Period: 86400,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the namespaces are the ones the services emit to", () => {
      expect(PIPELINE_METRIC_NAMESPACE).toBe("BillBoard/Pipeline");
      expect(ACCOUNTS_METRIC_NAMESPACE).toBe("BillBoard/Accounts");
    });

    test("the expired-push alarm explains watch and enforce", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Notifications-ExpiredUndelivered",
        AlarmDescription: Match.stringLikeRegexp("PENDING_EXPIRY_MODE=watch.*would_expire.*enforce"),
      });
    });

    // UX-33: the metric UserNotifier emits (services/src/handlers/userNotifier/index.ts, reportHeldRows).
    test("the held-push alarm names the pace it ships with and the warning that lists the rows", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Notifications-HeldPastLifetime",
        AlarmDescription: Match.stringLikeRegexp(
          "the 3-hour push pace.*Holding pending notifications past their 24-hour lifetime",
        ),
      });
    });

    // UX-33 review (F1): deleting the claims alone does not release a user held for the pace, since UserNotifier reads
    // the pace item again and holds them again.
    test("the held-push alarm says to delete the pace item before the claims", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Notifications-HeldPastLifetime",
        AlarmDescription: Match.stringLikeRegexp("__pace__#<user> item, then their __claim__#<user> items.*8 AM"),
      });
    });
  });

  // C2 3.11: routine alarms on the account-integrity metrics the services emit as EMF lines
  // without dimensions. Missing data is not breaching: no votes, verifications or sign-ups is normal.
  describe("account integrity (C2 3.11)", () => {
    const integrity = (name: string, metricName: string, period: number, threshold: number) => [name, metricName, period, threshold] as const;
    const detection = (name: string, metricName: string, { threshold, periodMinutes }: { threshold: number; periodMinutes: number }) =>
      integrity(name, metricName, periodMinutes * 60, threshold);
    const { voteDailyCapExceeded, voteVelocity, addressVerificationBurst, addressCapSignal } = ACCOUNT_INTEGRITY_ALARM_THRESHOLDS;

    test("the six alarms C2 3.11 lists, and the sign-up filter check's (CB-07)", () => {
      expect(ACCOUNT_INTEGRITY_ALARM_NAMES).toEqual([
        "Billboard-Integrity-VoteDailyCapExceeded",
        "Billboard-Integrity-VoteVelocity",
        "Billboard-Integrity-AddressVerificationBurst",
        "Billboard-Integrity-AddressCapSignal",
        "Billboard-Integrity-SignUpFilterHits",
        "Billboard-Integrity-SignUpFilterErrors",
        "Billboard-Integrity-SignUpFilterCheckFailed",
        "Billboard-Integrity-GeocoderVintageFallback",
      ]);
    });

    test.each([
      detection("Billboard-Integrity-VoteDailyCapExceeded", "VoteDailyCapExceeded", voteDailyCapExceeded),
      detection("Billboard-Integrity-VoteVelocity", "VotesCast", voteVelocity),
      detection("Billboard-Integrity-AddressVerificationBurst", "AddressVerified", addressVerificationBurst),
      integrity("Billboard-Integrity-SignUpFilterHits", "SignUpFilterHit", 3600, 1),
      integrity("Billboard-Integrity-SignUpFilterErrors", "PreSignUpCheckError", 900, 1),
      integrity("Billboard-Integrity-GeocoderVintageFallback", "GeocoderVintageFallback", 3600, 1),
    ])("%s: %s Sum over %i s, at least %i", (alarmName, metricName, period, threshold) => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName,
        Namespace: "BillBoard/AccountIntegrity",
        MetricName: metricName,
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: period,
        Threshold: threshold,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("Billboard-Integrity-AddressCapSignal sums the three INT-03 limit signals over its window", () => {
      const signal = (id: string, metricName: string) => Match.objectLike({
        Id: id,
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: "BillBoard/AccountIntegrity", MetricName: metricName },
          Period: addressCapSignal.periodMinutes * 60,
          Stat: "Sum",
        },
      });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Integrity-AddressCapSignal",
        Metrics: [
          Match.objectLike({ Expression: "SUM([addressLimit, reverificationLimit, streetCluster])", ReturnData: true }),
          signal("addressLimit", "AddressLimitReached"),
          signal("reverificationLimit", "ReverificationLimitReached"),
          signal("streetCluster", "StreetClusterFlagged"),
        ],
        Threshold: addressCapSignal.threshold,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("each description names its mode and where to look", () => {
      const descriptions = Object.fromEntries(Object.values(metricAlarms())
        .filter((resource) => ACCOUNT_INTEGRITY_ALARM_NAMES.includes(resource.Properties.AlarmName))
        .map((resource) => [resource.Properties.AlarmName, resource.Properties.AlarmDescription as string]));
      expect(descriptions["Billboard-Integrity-VoteDailyCapExceeded"]).toMatch(new RegExp(`VOTE_DAILY_CAP_MODE=watch.*/aws/lambda/SetFeedback.*${VOTE_DAILY_CAP_ENFORCE_READY_MAX}`));
      expect(descriptions["Billboard-Integrity-VoteVelocity"]).toMatch(/\/aws\/lambda\/SetFeedback/);
      expect(descriptions["Billboard-Integrity-AddressVerificationBurst"]).toMatch(/\/aws\/lambda\/DistrictVerification/);
      // No fact about how many accounts production has: the text is public.
      expect(descriptions["Billboard-Integrity-AddressVerificationBurst"]).toContain("Real accounts verify rarely, so a burst can be address farming.");
      expect(descriptions["Billboard-Integrity-AddressVerificationBurst"]).not.toMatch(/\d+ verified accounts at/);
      expect(descriptions["Billboard-Integrity-AddressCapSignal"]).toMatch(/VERIFICATION_LIMITS_MODE=watch.*\/aws\/lambda\/DistrictVerification/);
      expect(descriptions["Billboard-Integrity-SignUpFilterHits"]).toMatch(/SIGNUP_FILTER_MODE=watch.*\/aws\/lambda\/PreSignUpCheck/);
      expect(descriptions["Billboard-Integrity-SignUpFilterErrors"]).toMatch(/fails open.*PRE_SIGN_UP_TRIGGER_ENABLED=false/);
      expect(descriptions["Billboard-Integrity-SignUpFilterCheckFailed"]).toMatch(
        /SignUpFilterCheckFailed \+ SignUpFilterCheckSwept.*\/aws\/lambda\/SignUpFilterCheck.*RUNBOOK 14\.12.*SIGNUP_FILTER_CHECK_ENABLED/,
      );
      expect(descriptions["Billboard-Integrity-GeocoderVintageFallback"]).toMatch(
        /ACS2025_Current.*Missouri.*\/aws\/lambda\/DistrictVerification.*Census geocoder gave no usable answer.*RUNBOOK 14\.4/,
      );
    });

    test("the two new functions get Errors alarms, and the re-stamp queues an age and a DLQ alarm", () => {
      ["PreSignUpCheck", "RestampUserVotes"].forEach((functionName) =>
        expect(MONITORED_LAMBDA_NAMES).toContain(functionName));
      expect(MONITORED_WORK_QUEUE_NAMES).toContain("RestampUserVotesQueue");
      expect(MONITORED_DLQ_NAMES).toContain("RestampUserVotesDLQ");
      expect(THROTTLE_MONITORED_LAMBDA_NAMES).not.toContain("PreSignUpCheck");
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-SQS-RestampUserVotesDLQ-VisibleMessages",
        Dimensions: [{ Name: "QueueName", Value: "RestampUserVotesDLQ" }],
        Threshold: 1,
        AlarmDescription: Match.stringLikeRegexp("re-stamp.*redrive.*idempotent"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the dashboard shows the integrity alarms and graphs every account-integrity metric", () => {
      const body = dashboardBody(templates.monitoringTemplate);
      const integrityWidget = body.widgets.find((widget) => widget.type === "alarm" && widget.properties.title === "Alarms: account integrity");
      expect(integrityWidget).toBeDefined();
      expect([...integrityWidget!.properties.alarms].sort()).toEqual(
        ACCOUNT_INTEGRITY_ALARM_NAMES.map((name) => `alarm:${alarmLogicalId(name)}`).sort(),
      );
      // The header says what a switch does, not where production has it.
      expect(sectionHeaders(body)).toContain(
        "## 5. Account integrity: INT-06 votes, INT-03 verification, INT-05 sign-ups and the re-stamp. Under watch (or plan) each switch records what enforce would refuse.",
      );
      const text = JSON.stringify(body);
      [
        "VotesCast", "VoteDailyCapExceeded", "AddressVerified", "AddressLimitReached", "ReverificationLimitReached",
        "StreetClusterFlagged", "AddressVerifiedIpMismatch", "SignUpFilterHit", "SignUpRejected", "PreSignUpCheckError",
        "VotesRestampPlanned", "VotesRestamped", "MemberVotesCarriable", "MemberVotesCarried",
        // CB-07: the check's probes and its runs.
        "SignUpProbeHit", "SignUpProbeRejected", "SignUpFilterCheckPassed", "SignUpFilterCheckFailed",
        "SignUpFilterCheckInconclusive", "SignUpFilterCheckDisabled", "SignUpFilterCheckSwept",
      ].forEach((metricName) => expect(text).toContain(`"${metricName}"`));
    });
  });

  // REL-53 (feature review S10, S17): real sign-ups and the cleanup of those left unconfirmed, in BillBoard/Accounts.
  describe("sign-ups and the unconfirmed sign-up cleanup (REL-53)", () => {
    const services = path.join(__dirname, "..", "..", "services", "src");
    const read = (...parts: string[]) => fs.readFileSync(path.join(services, ...parts), "utf8");

    test("the dashboard graphs the real sign-ups, the cleanup's counts and every skip reason, daily", () => {
      const widgets = dashboardBody(templates.monitoringTemplate).widgets.filter(
        (widget) => widget.type === "metric" && /Sign-ups \(not probes\)|Unconfirmed sign-up cleanup/.test(widget.properties.title),
      );
      expect(widgets).toHaveLength(2);
      const text = JSON.stringify(widgets);
      [
        "SignUpAllowed",
        "SignUpsConfirmed",
        "UnconfirmedSignUpsExpired",
        "UnconfirmedSignUpsDeleted",
        "UnconfirmedSignUpsPending",
        "UnconfirmedSignUpsSkipped",
        "UnconfirmedSignUpCleanupErrors",
        "UnconfirmedSignUpCleanupCapReached",
      ].forEach((metricName) => expect(text).toContain(`"${metricName}"`));
      UNCONFIRMED_SIGN_UP_SKIP_REASONS.forEach((reason) => expect(text).toContain(`"Reason","${reason}"`));
      for (const metric of widgets.flatMap((widget) => widget.properties.metrics as unknown[][])) {
        expect(metric[0]).toBe(ACCOUNTS_METRIC_NAMESPACE);
        expect(metric[metric.length - 1]).toEqual(expect.objectContaining({ period: 86400 }));
      }
    });

    test("the alarm names the switch and the runbook section, and is no page", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Accounts-UnconfirmedSignUpCleanupErrors",
        AlarmDescription: Match.stringLikeRegexp("unconfirmedSignUps.*UNCONFIRMED_SIGNUP_CLEANUP_MODE.*RUNBOOK 8\\.2"),
      });
      const pageRules = JSON.stringify(Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmRule));
      expect(pageRules).not.toContain(`"${alarmLogicalId("Billboard-Accounts-UnconfirmedSignUpCleanupErrors")}"`);
    });

    test("the namespace, metric names and skip reasons are the ones the services emit", () => {
      const step = read("handlers", "cleanupOrphanedUsers", "unconfirmedSignUps.ts");
      const cleanup = read("handlers", "cleanupOrphanedUsers", "index.ts");
      const preSignUp = read("handlers", "preSignUp", "index.ts");
      expect(step).toContain(`export const UNCONFIRMED_METRICS_NAMESPACE = "${ACCOUNTS_METRIC_NAMESPACE}";`);
      expect(cleanup).toContain(`export const ACCOUNT_METRICS_NAMESPACE = "${ACCOUNTS_METRIC_NAMESPACE}";`);
      expect(cleanup).toContain('export const SIGN_UPS_CONFIRMED_METRIC = "SignUpsConfirmed";');
      expect(preSignUp).toContain(`export const ACCOUNTS_NAMESPACE = "${ACCOUNTS_METRIC_NAMESPACE}";`);
      expect(preSignUp).toContain('export const SIGN_UP_ALLOWED_METRIC = "SignUpAllowed";');
      [
        "UnconfirmedSignUpsDeleted",
        "UnconfirmedSignUpsExpired",
        "UnconfirmedSignUpsPending",
        "UnconfirmedSignUpsSkipped",
        "UnconfirmedSignUpCleanupErrors",
        "UnconfirmedSignUpCleanupCapReached",
      ].forEach((metricName) => expect(step).toContain(`name: "${metricName}"`));
      const reasons = /export const SKIP_REASONS = \[([^\]]*)\]/.exec(step)?.[1] ?? "";
      expect([...reasons.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([...UNCONFIRMED_SIGN_UP_SKIP_REASONS]);
    });
  });

  // CB-07: the sign-up filter check's two routine alarms, on the EMF metrics it writes without dimensions. Neither
  // pages and neither is on a deployment group.
  describe("the sign-up filter check (CB-07)", () => {
    const checkMetric = (id: string, metricName: string) =>
      Match.objectLike({
        Id: id,
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: "BillBoard/SignUpFilterCheck", MetricName: metricName },
          Period: 3600,
          Stat: "Sum",
        },
      });

    test("Billboard-Integrity-SignUpFilterCheckFailed: a failed run or a swept leftover in an hour, routine", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Integrity-SignUpFilterCheckFailed",
        Metrics: [
          Match.objectLike({ Expression: "FILL(failed, 0) + FILL(swept, 0)", ReturnData: true }),
          checkMetric("failed", "SignUpFilterCheckFailed"),
          checkMetric("swept", "SignUpFilterCheckSwept"),
        ],
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        OKActions: Match.absent(),
      });
    });

    test("Billboard-Freshness-SignUpFilterCheck: no pass (or off) for 26 hours, missing data breaching, routine", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Freshness-SignUpFilterCheck",
        AlarmDescription: Match.stringLikeRegexp("26 hours.*11:30 UTC.*RUNBOOK 14.12.*SIGNUP_FILTER_CHECK_ENABLED is false"),
        Metrics: [
          Match.objectLike({ Expression: "FILL(passed, 0) + FILL(disabled, 0)", ReturnData: true }),
          checkMetric("passed", "SignUpFilterCheckPassed"),
          checkMetric("disabled", "SignUpFilterCheckDisabled"),
        ],
        Threshold: 0,
        ComparisonOperator: "LessThanOrEqualToThreshold",
        EvaluationPeriods: 26,
        DatapointsToAlarm: 26,
        TreatMissingData: "breaching",
        AlarmActions: [alarmTopicRef],
      });
    });

    test("the function has its Errors alarm, and neither check alarm is a page or a page member", () => {
      expect(MONITORED_LAMBDA_NAMES).toContain("SignUpFilterCheck");
      expect(THROTTLE_MONITORED_LAMBDA_NAMES).not.toContain("SignUpFilterCheck");
      const pageRules = JSON.stringify(Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmRule));
      ["Billboard-Integrity-SignUpFilterCheckFailed", "Billboard-Freshness-SignUpFilterCheck", "Billboard-Lambda-SignUpFilterCheck-Errors"]
        .forEach((alarmName) => expect(pageRules).not.toContain(`"${alarmLogicalId(alarmName)}"`));
    });

    test("the namespace and every metric the alarms and dashboard read are the ones the services emit", () => {
      const services = path.join(__dirname, "..", "..", "services", "src");
      const common = fs.readFileSync(path.join(services, "handlers", "signUpFilterCheck", "common.ts"), "utf8");
      const handler = fs.readFileSync(path.join(services, "handlers", "signUpFilterCheck", "index.ts"), "utf8");
      const preSignUp = fs.readFileSync(path.join(services, "handlers", "preSignUp", "index.ts"), "utf8");
      expect(SIGNUP_FILTER_CHECK_METRIC_NAMESPACE).toBe("BillBoard/SignUpFilterCheck");
      expect(common).toContain(`export const SIGNUP_FILTER_CHECK_METRIC_NAMESPACE = "${SIGNUP_FILTER_CHECK_METRIC_NAMESPACE}";`);
      [
        "SignUpFilterCheckPassed",
        "SignUpFilterCheckFailed",
        "SignUpFilterCheckInconclusive",
        "SignUpFilterCheckSwept",
        "SignUpFilterCheckSignUps",
        "SignUpFilterCheckDisabled",
      ].forEach((metricName) => expect(handler).toContain(`name: "${metricName}"`));
      expect(preSignUp).toContain('probeHit: "SignUpProbeHit"');
      expect(preSignUp).toContain('probeRejected: "SignUpProbeRejected"');
    });
  });

  // C3 3.11: routine alarms on the App Attest EMF metrics, none paging and none a page member. Missing data is not
  // breaching: builds that do not attest send none.
  describe("App Attest (C3 3.11)", () => {
    test("the four alarms are the ones C3 3.11 lists, on the namespace the services write", () => {
      expect(APP_ATTEST_ALARM_NAMES).toEqual([
        "Billboard-AppAttest-Invalid",
        "Billboard-AppAttest-Errors",
        "Billboard-AppAttest-Rejected",
        "Billboard-AppAttest-ChallengeFlood",
      ]);
      const config = fs.readFileSync(path.join(__dirname, "..", "..", "services", "src", "shared", "appAttest", "config.ts"), "utf8");
      expect(config).toContain(`export const METRIC_NAMESPACE = "${APP_ATTEST_METRIC_NAMESPACE}";`);
    });

    test.each([
      ["Billboard-AppAttest-Invalid", "AppAttestInvalid", APP_ATTEST_ALARM_THRESHOLDS.invalid],
      ["Billboard-AppAttest-Errors", "AppAttestErrors", APP_ATTEST_ALARM_THRESHOLDS.errors],
      ["Billboard-AppAttest-Rejected", "AppAttestRejected", APP_ATTEST_ALARM_THRESHOLDS.rejected],
      ["Billboard-AppAttest-ChallengeFlood", "AppAttestChallenges", APP_ATTEST_ALARM_THRESHOLDS.challengeFlood],
    ])("%s: %s Sum over an hour, at least %i, on the alarm topic only", (alarmName, metricName, threshold) => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName,
        Namespace: "BillBoard/AppAttest",
        MetricName: metricName,
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 3600,
        Threshold: threshold,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmActions: [alarmTopicRef],
        OKActions: Match.absent(),
        InsufficientDataActions: Match.absent(),
      });
    });

    // The services emit these four without dimensions (services/src/shared/appAttest/evaluate.ts and the handler).
    test("the alarmed metrics are emitted by the services without dimensions", () => {
      const evaluate = fs.readFileSync(path.join(__dirname, "..", "..", "services", "src", "shared", "appAttest", "evaluate.ts"), "utf8");
      const handler = fs.readFileSync(path.join(__dirname, "..", "..", "services", "src", "handlers", "appAttest", "index.ts"), "utf8");
      ["AppAttestInvalid", "AppAttestErrors", "AppAttestRejected"].forEach((metricName) =>
        expect(evaluate).toContain(`name: "${metricName}"`));
      expect(handler).toContain('name: "AppAttestChallenges"');
    });

    test("none is a page or a page member, and the descriptions say where to look", () => {
      const pageRules = JSON.stringify(Object.values(compositeAlarms()).map((resource) => resource.Properties.AlarmRule));
      APP_ATTEST_ALARM_NAMES.forEach((alarmName) => expect(pageRules).not.toContain(`"${alarmLogicalId(alarmName)}"`));
      const descriptions = Object.fromEntries(Object.values(metricAlarms())
        .filter((resource) => APP_ATTEST_ALARM_NAMES.includes(resource.Properties.AlarmName))
        .map((resource) => [resource.Properties.AlarmName, resource.Properties.AlarmDescription as string]));
      expect(descriptions["Billboard-AppAttest-Invalid"]).toMatch(/\/aws\/lambda\/SetFeedback.*\/aws\/lambda\/PreSignUpCheck.*report:app-attest/);
      expect(descriptions["Billboard-AppAttest-Errors"]).toMatch(/fails open while APP_ATTEST_FAIL_CLOSED is false/);
      expect(descriptions["Billboard-AppAttest-Rejected"]).toMatch(/stays 0 while APP_ATTEST_VOTE_MODE and APP_ATTEST_SIGN_UP_MODE are watch, so it fires only after an enforce flip.*back to watch in infra\/lib\/config\/abuse-limits\.ts and deploy/);
      expect(descriptions["Billboard-AppAttest-ChallengeFlood"]).toMatch(
        new RegExp(`reserved concurrency of ${APP_ATTEST_RESERVED_CONCURRENCY}.*Billboard-Lambda-AppAttest-Throttles.*APP_ATTEST_CLIENT_MODE=off`),
      );
    });

    test("the AppAttest function gets an Errors alarm and a Throttles alarm that explains the public routes", () => {
      expect(MONITORED_LAMBDA_NAMES).toContain("AppAttest");
      expect(THROTTLE_MONITORED_LAMBDA_NAMES).toContain("AppAttest");
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Lambda-AppAttest-Errors",
        Dimensions: [{ Name: "FunctionName", Value: "AppAttest" }],
        AlarmActions: [alarmTopicRef],
      });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Lambda-AppAttest-Throttles",
        Dimensions: [{ Name: "FunctionName", Value: "AppAttest" }],
        AlarmDescription: Match.stringLikeRegexp(`reserved concurrency of ${APP_ATTEST_RESERVED_CONCURRENCY}.*stage throttles.*500.*Billboard-API-5XXError.*lower APP_ATTEST_CHALLENGE_THROTTLE or raise APP_ATTEST_RESERVED_CONCURRENCY \\(infra/lib/config/abuse-limits\\.ts\\)`),
        AlarmActions: [alarmTopicRef],
      });
      // The other throttle alarms keep the queue-and-schedule wording.
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Lambda-FetchRawBill-Throttles",
        AlarmDescription: Match.stringLikeRegexp("Work is waiting in its queue or schedule"),
      });
    });

    test("the dashboard shows the App Attest alarms and graphs every App Attest metric", () => {
      const body = dashboardBody(templates.monitoringTemplate);
      const widget = body.widgets.find((candidate) => candidate.type === "alarm" && candidate.properties.title === "Alarms: App Attest");
      expect(widget).toBeDefined();
      expect([...widget!.properties.alarms].sort()).toEqual(
        APP_ATTEST_ALARM_NAMES.map((name) => `alarm:${alarmLogicalId(name)}`).sort(),
      );
      expect(sectionHeaders(body)).toContain(
        "## 6. App Attest (INT-04): votes and sign-ups by outcome, attestations, challenges, DeviceCheck. The readiness report is npm run report:app-attest.",
      );
      const text = JSON.stringify(body);
      [
        "AppAttestRequests", "AppAttestInvalid", "AppAttestErrors", "AppAttestRejected", "AppAttestOverLimit",
        "AppAttestChallenges", "AppAttestAttestations", "DeviceCheckCalls",
      ].forEach((metricName) => expect(text).toContain(metricName));
      expect(text).toContain("SEARCH('{BillBoard/AppAttest,Outcome,Route} MetricName=\\\"AppAttestRequests\\\"', 'Sum', 3600)");
    });
  });

  // LLM-11 and REL-40: routine alarms on what BillSummarizer and BillPriorityResolver write per Bedrock call
  // (BillBoard/Bedrock) and per stored summary (BillBoard/BillIngestion), all as EMF lines without dimensions.
  describe("Bedrock and summary repairs (LLM-11, REL-40)", () => {
    const BEDROCK_ALARM_NAMES = [
      "Billboard-Bedrock-RequestRejected",
      "Billboard-Summarizer-FieldRepairRate",
      "Billboard-Priority-NoModelAnswer",
    ];
    const ALARMED_BEDROCK_METRICS = ["BedrockRequestRejected", "BedrockThrottled", "PriorityResolverNoAnswer"];
    const GRAPHED_BEDROCK_METRICS = ["BedrockCalls", "BedrockLatency", "BedrockOutputTokens", "BedrockRefusal"];
    // REL-51: what "In the news" picks and what each resolver call sends.
    const IN_THE_NEWS_METRICS = ["PriorityPassingBills", "PriorityNewPicks", "PriorityInputTokens"];
    const SUMMARY_METRICS = [
      "BillSummarizerStored",
      "BillSummarizerAnalysisRejected",
      "BillSummarizerAnalysisRevised",
      "BillSummarizerRepairedBills",
      "BillSummarizerFieldRepaired",
    ];

    test("Billboard-Bedrock-RequestRejected fires on one rejected request in 5 minutes and is an ingest member", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Bedrock-RequestRejected",
        Namespace: BEDROCK_METRIC_NAMESPACE,
        MetricName: "BedrockRequestRejected",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("do not retry.*invalid_request, access_denied or not_found.*RUNBOOK 2\\.4, 11\\.7"),
        AlarmActions: [alarmTopicRef],
      });
      expect(ruleMemberIds(compositeNamed("Billboard-Ingest-Unhealthy"))).toContain(alarmLogicalId("Billboard-Bedrock-RequestRejected"));
    });

    // Under 10 stored summaries a day the rate is 0, and a day with none fitted counts as 0%, not missing.
    test("Billboard-Summarizer-FieldRepairRate fires when over 10% of at least 10 summaries in a day were fitted", () => {
      const summaryMetric = (id: string, metricName: string) => Match.objectLike({
        Id: id,
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: metricName },
          Period: 86400,
          Stat: "Sum",
        },
      });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Summarizer-FieldRepairRate",
        Metrics: [
          Match.objectLike({ Expression: "IF(stored >= 10, 100 * FILL(repaired, 0) / stored, 0)", ReturnData: true }),
          summaryMetric("stored", "BillSummarizerStored"),
          summaryMetric("repaired", "BillSummarizerRepairedBills"),
        ],
        Threshold: 10,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("analysis_repaired.*original text.*RUNBOOK 11\\.7"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("Billboard-Priority-NoModelAnswer fires on resolver runs without a model answer in 3 of 6 hours", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Priority-NoModelAnswer",
        Namespace: BEDROCK_METRIC_NAMESPACE,
        MetricName: "PriorityResolverNoAnswer",
        Dimensions: Match.absent(),
        Statistic: "Sum",
        Period: 3600,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 6,
        DatapointsToAlarm: 3,
        TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("neither its Errors alarm nor its heartbeat.*priority_no_answer"),
        AlarmActions: [alarmTopicRef],
      });
    });

    test("none pages, the rejection and repair alarms show with ingestion and the resolver's with the service", () => {
      const pageRules = JSON.stringify(PAGE_COMPOSITE_ALARM_NAMES.map((name) => compositeNamed(name).Properties.AlarmRule));
      BEDROCK_ALARM_NAMES.forEach((alarmName) => expect(pageRules).not.toContain(`"${alarmLogicalId(alarmName)}"`));
      const widgetAlarms = (title: string): string[] =>
        dashboardBody(templates.monitoringTemplate).widgets.find((widget) => widget.type === "alarm" && widget.properties.title === title)!
          .properties.alarms;
      expect(widgetAlarms("Alarms: ingestion")).toEqual(expect.arrayContaining([
        `alarm:${alarmLogicalId("Billboard-Bedrock-RequestRejected")}`,
        `alarm:${alarmLogicalId("Billboard-Summarizer-FieldRepairRate")}`,
        `alarm:${alarmLogicalId("Billboard-Bedrock-InvocationThrottles")}`,
      ]));
      expect(widgetAlarms("Alarms: API, freshness and delivery")).toContain(`alarm:${alarmLogicalId("Billboard-Priority-NoModelAnswer")}`);
    });

    // A twice-refused bill is acknowledged as billSummarizer.refused; it has no alarm of its own.
    test("refusals go to MessagesUnprocessable, and the BillSummarizerDLQ alarm says what still dead-letters", () => {
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-Pipeline-MessagesUnprocessable",
        AlarmDescription: Match.stringLikeRegexp("billSummarizer\\.refused.*previous summary.*again on each later raw write.*RUNBOOK 11\\.7"),
      });
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-SQS-BillSummarizerDLQ-VisibleMessages",
        Dimensions: [{ Name: "QueueName", Value: "BillSummarizerDLQ" }],
        Threshold: 1,
        AlarmDescription: Match.stringLikeRegexp(
          "5 receives \\(about 30 minutes\\).*REL-40.*Billboard-Pipeline-MessagesUnprocessable.*analysis_rejected.*14 days.*RUNBOOK 11\\.7",
        ),
        AlarmActions: [alarmTopicRef],
      });
      // The other ingest DLQs keep the default wording (UpdatedBillsDLQ has its own since OBS-21).
      templates.monitoringTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "Billboard-SQS-BillVoteEnrichmentDLQ-VisibleMessages",
        AlarmDescription: "BillVoteEnrichmentDLQ has at least one message pending investigation. Inspect failed payloads and source Lambda logs before redriving.",
      });
    });

    test("the dashboard graphs Bedrock calls by caller and outcome, answered-call latency and the summary counts", () => {
      const text = JSON.stringify(dashboardBody(templates.monitoringTemplate));
      expect(text).toContain("SEARCH('{BillBoard/Bedrock,Caller,Outcome} MetricName=\\\"BedrockCalls\\\"', 'Sum', 300)");
      ["p50", "p95"].forEach((statistic) => expect(text).toContain(
        `SEARCH('{BillBoard/Bedrock,Caller,Outcome} MetricName=\\\"BedrockLatency\\\" Outcome=\\\"ok\\\"', '${statistic}', 300)`,
      ));
      [...ALARMED_BEDROCK_METRICS, ...GRAPHED_BEDROCK_METRICS, ...SUMMARY_METRICS].forEach((metricName) =>
        expect(text).toContain(metricName));
    });

    test("the dashboard graphs In the news picks per hour and the resolver's input tokens (REL-51)", () => {
      const widget = dashboardBody(templates.monitoringTemplate).widgets.find(
        (candidate) => candidate.type === "metric" && String(candidate.properties.title).startsWith("In the news:"),
      );
      expect(widget).toBeDefined();
      const metrics = widget!.properties.metrics as unknown[][];
      expect(metrics.map((metric) => metric.slice(0, 2))).toEqual([
        ["BillBoard/Bedrock", "PriorityPassingBills"],
        ["BillBoard/Bedrock", "PriorityNewPicks"],
        ["BillBoard/Bedrock", "PriorityInputTokens"],
      ]);
      metrics.forEach((metric) => expect(metric[2]).toEqual(expect.objectContaining({ period: 3600, stat: "Sum" })));
      expect(metrics[2][2]).toEqual(expect.objectContaining({ yAxis: "right" }));
    });

    // The alarms and graphs only work if the services write exactly these names to these namespaces.
    test("the services emit every Bedrock and summary metric the alarms and dashboard read", () => {
      const sourcesUnder = (directory: string): string[] =>
        fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            return entry.name === "tests" ? [] : sourcesUnder(entryPath);
          }
          return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [fs.readFileSync(entryPath, "utf8")] : [];
        });
      const services = sourcesUnder(path.join(__dirname, "..", "..", "services", "src")).join("\n");
      const notEmitted = [
        BEDROCK_METRIC_NAMESPACE,
        ...ALARMED_BEDROCK_METRICS,
        ...GRAPHED_BEDROCK_METRICS,
        ...IN_THE_NEWS_METRICS,
        ...SUMMARY_METRICS,
      ]
        .filter((name) => !new RegExp(`["'\`]${name}["'\`]`).test(services));
      expect(notEmitted).toEqual([]);
    });
  });

  // REL-54: SES's account reputation, routine; the user pool sends its codes through SES since step 2.
  describe("email (REL-54)", () => {
    test.each([
      ["Billboard-Email-BounceRate", "Reputation.BounceRate", 0.03, /reached 3%.*review at 5%.*pause its sending at 10%.*RUNBOOK 23\.5/],
      ["Billboard-Email-ComplaintRate", "Reputation.ComplaintRate", 0.0005, /reached 0\.05%.*review at 0\.1%.*pause its sending at 0\.5%.*RUNBOOK 23\.5/],
    ])("%s alarms on the account's %s at %s, routine, missing data ignored", (alarmName, metricName, threshold, description) => {
      expect(SES_METRIC_NAMESPACE).toBe("AWS/SES");
      const alarm = metricAlarms()[alarmLogicalId(alarmName)].Properties;
      expect(alarm).toEqual({
        AlarmName: alarmName,
        AlarmDescription: expect.stringMatching(description),
        Namespace: "AWS/SES",
        MetricName: metricName,
        // Account-level: SES reviews and pauses the account on these, not on a configuration set's.
        Statistic: "Maximum",
        Period: 3600,
        Threshold: threshold,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        // AWS's advice for these alarms: an hour with nothing sent can have no datapoint while the rate is still
        // high, so the alarm keeps its state until SES publishes a rate below the threshold (RUNBOOK 23.5).
        TreatMissingData: "ignore",
        AlarmActions: [{ Ref: expect.stringMatching(/^AlarmTopic/) }],
      });
      expect(alarm.Dimensions).toBeUndefined();
    });

    test("the dashboard's email row shows both alarms, the reputation rates and the configuration set's counts", () => {
      const body = dashboardBody(templates.monitoringTemplate);
      const widget = body.widgets.find((candidate) => candidate.type === "alarm" && candidate.properties.title === "Alarms: email");
      expect([...widget!.properties.alarms].sort()).toEqual(
        SES_REPUTATION_ALARM_NAMES.map((name) => `alarm:${alarmLogicalId(name)}`).sort(),
      );
      const graphs = body.widgets.filter((candidate) => candidate.type === "metric" && /^(SES reputation|Account emails)/.test(candidate.properties.title));
      expect(graphs).toHaveLength(2);
      const reputation = JSON.stringify(graphs[0].properties.metrics);
      expect(reputation).toContain('"AWS/SES","Reputation.BounceRate"');
      expect(reputation).toContain('"AWS/SES","Reputation.ComplaintRate"');
      const counts = graphs[1].properties.metrics as unknown[][];
      expect(counts.map((metric) => metric.slice(0, 4))).toEqual(
        ["Send", "Delivery", "Bounce", "Complaint", "Reject", "DeliveryDelay"].map((name) => [
          "AWS/SES",
          name,
          "ses:configuration-set",
          "BillboardAccountEmail",
        ]),
      );
    });
  });

  describe("Slack only (C1.4)", () => {
    const slackConfigurations = (template: Template) =>
      Object.values(template.findResources("AWS::Chatbot::SlackChannelConfiguration"))
        .map((resource) => resource.Properties as Record<string, any>);
    const topicRefs = (configuration: Record<string, any>): string[] =>
      (configuration.SnsTopicArns as Array<{ Ref: string }>).map((arn) => arn.Ref.replace(/[0-9A-F]{8}$/, ""));

    test("without a paging channel, the alarm channel takes both topics, so pages arrive there", () => {
      const template = Template.fromStack(new MonitoringStack(new cdk.App(), "MonitoringStackWithSlack", {
        slackWorkspaceId: "T01234567",
        slackChannelId: "C01234567",
      }));
      const configurations = slackConfigurations(template);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]).toEqual(expect.objectContaining({
        ConfigurationName: "BillboardOpsAlarms",
        SlackWorkspaceId: "T01234567",
        SlackChannelId: "C01234567",
        LoggingLevel: "ERROR",
      }));
      expect(topicRefs(configurations[0])).toEqual(["AlarmTopic", "PageTopic"]);
      // Same construct ID as before, so this is an in-place update of SnsTopicArns.
      expect(Object.keys(template.findResources("AWS::Chatbot::SlackChannelConfiguration"))[0]).toMatch(/^SlackAlarmChannel/);
    });

    test("with a paging channel, only BillboardOpsPages takes the page topic", () => {
      const template = Template.fromStack(new MonitoringStack(new cdk.App(), "MonitoringStackWithPages", {
        slackWorkspaceId: "T01234567",
        slackChannelId: "C01234567",
        slackPageChannelId: "C07654321",
      }));
      const configurations = slackConfigurations(template);
      expect(configurations).toHaveLength(2);
      const byName = Object.fromEntries(configurations.map((configuration) => [configuration.ConfigurationName, configuration]));
      expect(topicRefs(byName.BillboardOpsAlarms)).toEqual(["AlarmTopic"]);
      expect(byName.BillboardOpsAlarms.SlackChannelId).toBe("C01234567");
      expect(topicRefs(byName.BillboardOpsPages)).toEqual(["PageTopic"]);
      expect(byName.BillboardOpsPages).toEqual(expect.objectContaining({
        SlackWorkspaceId: "T01234567",
        SlackChannelId: "C07654321",
        LoggingLevel: "ERROR",
      }));
    });

    test("rejects a paging channel without a Slack workspace", () => {
      expect(
        () => new MonitoringStack(new cdk.App(), "MonitoringStackWithPagesOnly", { slackPageChannelId: "C07654321" }),
      ).toThrow("Monitoring Slack pages (slackPageChannelId) require slackWorkspaceId and slackChannelId.");
    });

    test("subscribes nothing to either topic: no email or other SNS subscription", () => {
      const withSlack = Template.fromStack(new MonitoringStack(new cdk.App(), "MonitoringStackNoSubscriptions", {
        slackWorkspaceId: "T01234567",
        slackChannelId: "C01234567",
        slackPageChannelId: "C07654321",
      }));
      withSlack.resourceCountIs("AWS::SNS::Subscription", 0);
      templates.monitoringTemplate.resourceCountIs("AWS::SNS::Subscription", 0);
    });
  });

  test("rejects partial Slack alert configuration", () => {
    const app = new cdk.App();

    expect(
      () =>
        new MonitoringStack(app, "MonitoringStackWithPartialSlack", {
          slackWorkspaceId: "T01234567",
        })
    ).toThrow("Monitoring Slack alerts require both slackWorkspaceId and slackChannelId.");
  });

  // bin/billboard-infra.ts: an explicit empty string for either Slack context key switches Slack off, so a deployment
  // can synth without the workspace and channel in deployment-identity.ts.
  describe("the real app's Slack context", () => {
    const chatbotConfigurations = (context: Record<string, string>) => {
      const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
      const previousContext = process.env.CDK_CONTEXT_JSON;
      process.env.CDK_CONTEXT_JSON = JSON.stringify({ ...readJson("cdk.json").context, ...cachedLookups(), ...context });
      try {
        let stack: { template: { Resources?: Record<string, { Type: string }> } } | undefined;
        jest.isolateModules(() => {
          const { app } = require("../bin/billboard-infra") as typeof import("../bin/billboard-infra");
          stack = app.synth().getStackByName("MonitoringStack");
        });
        return Object.values(stack?.template.Resources ?? {}).filter(
          (resource) => resource.Type === "AWS::Chatbot::SlackChannelConfiguration",
        );
      } finally {
        if (previousContext === undefined) {
          delete process.env.CDK_CONTEXT_JSON;
        } else {
          process.env.CDK_CONTEXT_JSON = previousContext;
        }
      }
    };

    test.each([
      ["monitoringSlackWorkspaceId", { monitoringSlackWorkspaceId: "" }],
      ["monitoringSlackChannelId", { monitoringSlackChannelId: " " }],
    ])("an empty %s turns every Chatbot configuration off", (_key, context) => {
      expect(chatbotConfigurations(context)).toEqual([]);
    });
  });

  // The lists above are hand-maintained; this keeps them in step with what the real app deploys.
  describe("coverage of the real app", () => {
    type Resource = { Type: string; Properties?: Record<string, any> };
    let resources: Resource[] = [];

    beforeAll(() => {
      const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
      const previousContext = process.env.CDK_CONTEXT_JSON;
      process.env.CDK_CONTEXT_JSON = JSON.stringify({
        ...readJson("cdk.json").context,
        ...cachedLookups(),
      });
      try {
        const { app } = require("../bin/billboard-infra") as typeof import("../bin/billboard-infra");
        resources = app.synth().stacks.flatMap((stack) => Object.values(stack.template.Resources ?? {}) as Resource[]);
      } finally {
        if (previousContext === undefined) {
          delete process.env.CDK_CONTEXT_JSON;
        } else {
          process.env.CDK_CONTEXT_JSON = previousContext;
        }
      }
    });

    test("every release-backed Lambda has an Errors alarm", () => {
      const releaseBacked = resources
        .filter((resource) => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Handler === "dist/index.handler")
        .map((resource) => resource.Properties?.FunctionName as string)
        .sort();
      expect(releaseBacked).toEqual([...MONITORED_LAMBDA_NAMES].sort());
    });

    test("every SQS queue is monitored as a work queue or a DLQ", () => {
      const queueNames = resources
        .filter((resource) => resource.Type === "AWS::SQS::Queue")
        .map((resource) => resource.Properties?.QueueName as string)
        .sort();
      expect(queueNames).toEqual(
        [...MONITORED_WORK_QUEUE_NAMES, ...MONITORED_DLQ_NAMES].sort(),
      );
    });

    // C1.4: across every stack, the page topic is the action of the two page composites only. The service
    // stacks' alarms (alias errors, the API 5XX and canary rollback alarms) notify no one.
    test("in the whole app, only the two page composites name the page topic", () => {
      const alarms = resources.filter((resource) =>
        resource.Type === "AWS::CloudWatch::Alarm" || resource.Type === "AWS::CloudWatch::CompositeAlarm");
      const paging = alarms
        .filter((resource) => /PageTopic/.test(JSON.stringify([
          resource.Properties?.AlarmActions, resource.Properties?.OKActions, resource.Properties?.InsufficientDataActions,
        ])))
        .map((resource) => resource.Properties?.AlarmName)
        .sort();
      expect(paging).toEqual([...PAGE_COMPOSITE_ALARM_NAMES].sort());
    });

    test("the real app ships with pages in the existing Slack channel", () => {
      const configurations = resources.filter((resource) => resource.Type === "AWS::Chatbot::SlackChannelConfiguration");
      expect(configurations).toHaveLength(1);
      expect(configurations[0].Properties?.ConfigurationName).toBe("BillboardOpsAlarms");
      expect(JSON.stringify(configurations[0].Properties?.SnsTopicArns)).toMatch(/AlarmTopic.*PageTopic/);
      // No Slack context: the workspace and channel in deployment-identity.ts.
      expect(configurations[0].Properties).toMatchObject({
        SlackWorkspaceId: MONITORING_SLACK_WORKSPACE_ID,
        SlackChannelId: MONITORING_SLACK_CHANNEL_ID,
      });
    });

    test("no SNS subscription in the app subscribes an endpoint to an alarm topic", () => {
      const subscriptions = resources.filter((resource) => resource.Type === "AWS::SNS::Subscription");
      subscriptions.forEach((subscription) =>
        expect(JSON.stringify(subscription.Properties?.TopicArn)).not.toMatch(/AlarmTopic|PageTopic|BillboardAlarmTopic|BillboardPageTopic/),
      );
    });

    // C1 section 10: 171 alarms at U9, 153 after C1 (MonitoringStack 125 to 107; the service stacks' 46
    // unchanged). C2 and C3: MonitoringStack 107 to 123 (see above); the service stacks 46 to 50 (the three new
    // functions' alias error alarms and Billboard-Waf-CognitoSignUpRateLimited). LLM-11: MonitoringStack 123 to 126.
    // UA-04: Billboard-Canary-SmokeSignInFailed makes it 127 and 177. CB-07: MonitoringStack 127 to 130 (the check's
    // two alarms and its Errors alarm), the service stacks 50 to 51 (its alias error alarm): 181. INT-11:
    // Billboard-BillStats-ResultsGateReadFailed makes it 131 and 182. UX-31: Billboard-Votes-EarlierVoteReadFailed and
    // Billboard-CivicScore-RecordFailed make it 133 and 184. REL-53: Billboard-Accounts-UnconfirmedSignUpCleanupErrors
    // makes it 134 and 185. REL-52: Billboard-Ingestion-SenateClassInferred makes it 135 and 186. UX-33:
    // Billboard-Notifications-HeldPastLifetime makes it 136 and 187. REL-54: Billboard-Email-BounceRate and
    // Billboard-Email-ComplaintRate make it 138 and 189 (EmailStack has none of its own). REL-46:
    // Billboard-Integrity-GeocoderVintageFallback, Billboard-Ingestion-BillPollerLag119 and
    // Billboard-Ingestion-BillPollerStateMismatch make it 141 and 192.
    // Billboard-Heartbeat-BillsApiPoller makes it 142 and 193. REL-56: Billboard-Ingestion-BillPollerFilterImprecise,
    // Billboard-Ingestion-BillPollerPageDrift, Billboard-Ingestion-BillPollerFallback and
    // Billboard-Ingestion-BillPollerLateRows make it 146 and 197. REL-58: Billboard-Ingestion-FetchRawBillFailing
    // makes it 147 and 198.
    test("the app has 198 alarms: 147 in MonitoringStack and 51 in the service stacks", () => {
      const alarms = resources.filter((resource) =>
        resource.Type === "AWS::CloudWatch::Alarm" || resource.Type === "AWS::CloudWatch::CompositeAlarm");
      expect(alarms).toHaveLength(198);
      expect(Object.keys({ ...metricAlarms(), ...compositeAlarms() })).toHaveLength(147);
    });

    // infra/README.md gives the totals twice (the stack table and the alarm list); a PR that adds an alarm must move
    // both, or the README contradicts itself.
    test("infra/README.md gives the synthesized alarm totals wherever it states them", () => {
      const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
      const appAlarms = resources.filter((resource) =>
        resource.Type === "AWS::CloudWatch::Alarm" || resource.Type === "AWS::CloudWatch::CompositeAlarm");
      const stackTotals = [...readme.matchAll(/(\d+) metric alarms and (\d+) composites/g)].map((match) => [
        Number(match[1]),
        Number(match[2]),
      ]);
      const appTotals = [...readme.matchAll(/(\d+) in the app\b/g)].map((match) => Number(match[1]));

      expect(stackTotals).toEqual([
        [Object.keys(metricAlarms()).length, Object.keys(compositeAlarms()).length],
        [Object.keys(metricAlarms()).length, Object.keys(compositeAlarms()).length],
      ]);
      expect(appTotals).toEqual([appAlarms.length]);
    });

    // C2 3.6: the web ACL's name is generated, so the sign-up rule's alarm sits next to it in
    // UserAPIServiceStack and notifies MonitoringStack's alarm topic by name (alarmTopicFromName, X1).
    test("the WAF sign-up alarm notifies the routine alarm topic by name, never the page topic", () => {
      const wafAlarms = resources.filter((resource) =>
        resource.Type === "AWS::CloudWatch::Alarm" && resource.Properties?.AlarmName === "Billboard-Waf-CognitoSignUpRateLimited");
      expect(wafAlarms).toHaveLength(1);
      expect(wafAlarms[0].Properties?.AlarmActions).toEqual([
        expect.stringMatching(new RegExp(`^arn:aws:sns:us-east-1:\\d{12}:${ALARM_TOPIC_NAME}$`)),
      ]);
    });

    // One SERVICE monitor already exists live, outside CloudFormation; a second would fail to create.
    test("creates no Cost Anomaly Detection monitor", () => {
      expect(resources.filter((resource) => resource.Type.startsWith("AWS::CE::"))).toEqual([]);
    });
  });
});
