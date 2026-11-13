import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import {
  APP_ATTEST_FUNCTION_NAME,
  APP_ATTEST_METRIC_NAMESPACE,
} from '../../config/app-attest-constants';
import { APP_ATTEST_ALARM_THRESHOLDS, APP_ATTEST_RESERVED_CONCURRENCY } from '../../config/abuse-limits';

/** A count as the alarm text writes it: 1,000 rather than 1000. */
const count = (value: number): string => value.toLocaleString('en-US');

/**
 * App Attest (INT-04, C3 3.11): the four alarms on the EMF metrics SetFeedback, PreSignUpCheck and AppAttest write
 * under BillBoard/AppAttest without dimensions. All routine (MonitoringStack's alarm topic, through `notify`), none
 * a page or a page member, and missing data is not breaching: there may be no attesting client yet.
 */
export const APP_ATTEST_ALARM_NAMES: readonly string[] = [
  'Billboard-AppAttest-Invalid',
  'Billboard-AppAttest-Errors',
  'Billboard-AppAttest-Rejected',
  'Billboard-AppAttest-ChallengeFlood',
];

interface AppAttestAlarmSpec {
  /** Logical ID. Not `AppAttestErrorsAlarm`: MonitoringStack gives the AppAttest function's Errors alarm that ID. */
  readonly id: string;
  readonly alarmName: string;
  readonly metricName: string;
  readonly threshold: number;
  readonly description: string;
}

const SPECS: readonly AppAttestAlarmSpec[] = [
  {
    id: 'AppAttestMetricInvalidAlarm',
    alarmName: 'Billboard-AppAttest-Invalid',
    metricName: 'AppAttestInvalid',
    threshold: APP_ATTEST_ALARM_THRESHOLDS.invalid,
    description: `App Attest judged ${count(APP_ATTEST_ALARM_THRESHOLDS.invalid)} or more vote headers or sign-up assertions invalid in the last hour (AppAttestInvalid: a bad signature, an unknown or revoked key, a counter that did not increase, or client data that does not match the request). Forgery attempts or a verifier bug. Under watch nothing was refused. The "App Attest evaluated" lines in /aws/lambda/SetFeedback and /aws/lambda/PreSignUpCheck give the reason and keyIdPrefix; npm run report:app-attest summarises keys and outcomes. Do not flip a route to enforce while this fires unexplained.`,
  },
  {
    id: 'AppAttestMetricErrorsAlarm',
    alarmName: 'Billboard-AppAttest-Errors',
    metricName: 'AppAttestErrors',
    threshold: APP_ATTEST_ALARM_THRESHOLDS.errors,
    description: `The App Attest check in SetFeedback or PreSignUpCheck failed ${count(APP_ATTEST_ALARM_THRESHOLDS.errors)} or more times in the last hour on its own side (AppAttestErrors: the AppAttest table, a timeout, DeviceCheck or a bug). It fails open while APP_ATTEST_FAIL_CLOSED is false, so those votes and sign-ups went ahead unchecked. Check /aws/lambda/SetFeedback and /aws/lambda/PreSignUpCheck for the error, the AppAttest table, and Apple's DeviceCheck status if DEVICE_CHECK_MODE is not off.`,
  },
  {
    id: 'AppAttestMetricRejectedAlarm',
    alarmName: 'Billboard-AppAttest-Rejected',
    metricName: 'AppAttestRejected',
    threshold: APP_ATTEST_ALARM_THRESHOLDS.rejected,
    description: `App Attest refused ${count(APP_ATTEST_ALARM_THRESHOLDS.rejected)} or more votes or sign-ups in the last hour (AppAttestRejected). It stays 0 while APP_ATTEST_VOTE_MODE and APP_ATTEST_SIGN_UP_MODE are watch, so it fires only after an enforce flip: real users may be blocked. The log lines name the route and the code. If the verifier or the rollout is at fault, set the mode back to watch in infra/lib/config/abuse-limits.ts and deploy (10 minutes; RUNBOOK App Attest section).`,
  },
  {
    id: 'AppAttestMetricChallengeFloodAlarm',
    alarmName: 'Billboard-AppAttest-ChallengeFlood',
    metricName: 'AppAttestChallenges',
    threshold: APP_ATTEST_ALARM_THRESHOLDS.challengeFlood,
    description: `POST /app-attest/challenge issued ${count(APP_ATTEST_ALARM_THRESHOLDS.challengeFlood)} or more challenges in the last hour (AppAttestChallenges), far above one per install plus one per vote and sign-up: abuse of the public route. The route's own stage throttle (429s), the WAF's per-IP rule and the ${APP_ATTEST_FUNCTION_NAME} function's reserved concurrency of ${APP_ATTEST_RESERVED_CONCURRENCY} hold a flood there (see also Billboard-Lambda-${APP_ATTEST_FUNCTION_NAME}-Throttles), so other routes are unaffected; expired challenge rows leave the table by TTL. Check the route's requests and status codes in the API access logs (they hold no IP address) and whether the web ACL's UserApiRateLimitRule blocked an IP (its BlockedRequests metric); the ACL keeps no sampled requests (privacy, WEB-07). R2's kill switch is APP_ATTEST_CLIENT_MODE=off.`,
  },
];

/**
 * Creates the four alarms in `scope` (MonitoringStack) and passes each to `notify`, which adds the routine alarm
 * action and puts it on the dashboard. Returns them in APP_ATTEST_ALARM_NAMES order.
 */
export const addAppAttestAlarms = (
  scope: Construct,
  notify: (alarm: cloudwatch.Alarm) => cloudwatch.Alarm,
): cloudwatch.Alarm[] =>
  SPECS.map(({ id, alarmName, metricName, threshold, description }) =>
    notify(new cloudwatch.Alarm(scope, id, {
      alarmName,
      alarmDescription: description,
      metric: appAttestMetric(metricName),
      threshold,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })),
  );

/** One BillBoard/AppAttest metric, summed per hour (the alarms' period; also used by the dashboard). */
export const appAttestMetric = (
  metricName: string,
  dimensionsMap?: Record<string, string>,
): cloudwatch.Metric =>
  new cloudwatch.Metric({
    namespace: APP_ATTEST_METRIC_NAMESPACE,
    metricName,
    dimensionsMap,
    statistic: 'Sum',
    period: cdk.Duration.hours(1),
  });
