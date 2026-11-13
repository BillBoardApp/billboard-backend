import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** Name of the SNS topic MonitoringStack creates for alarm notifications (the routine tier). */
export const ALARM_TOPIC_NAME = 'BillboardAlarmTopic';

/**
 * Name of the SNS topic MonitoringStack creates for pages (C1.4). Only the two page composites
 * (Billboard-Page-AppBroken, Billboard-Page-PushesDown) notify it; every other alarm uses the alarm topic
 * through `notify()` or has no action. No stack should resolve it by name to add another page.
 */
export const PAGE_TOPIC_NAME = 'BillboardPageTopic';

const ALARM_TOPIC_IMPORT_ID = 'BillboardAlarmTopicImport';

/**
 * Resolves the alarm topic owned by MonitoringStack by name, in the calling
 * stack's account and region. Building the ARN locally (instead of passing the
 * Topic across stacks) avoids a CloudFormation export/import between
 * MonitoringStack and every service stack.
 *
 * There is no CloudFormation dependency on MonitoringStack, so in a fresh
 * account notifications only arrive once MonitoringStack has created the topic.
 *
 * Safe to call repeatedly: the import is created once per stack and reused.
 */
export const alarmTopicFromName = (scope: Construct): sns.ITopic => {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild(ALARM_TOPIC_IMPORT_ID);
  if (existing) {
    return existing as sns.ITopic;
  }
  return sns.Topic.fromTopicArn(
    stack,
    ALARM_TOPIC_IMPORT_ID,
    stack.formatArn({
      service: 'sns',
      resource: ALARM_TOPIC_NAME,
    }),
  );
};
