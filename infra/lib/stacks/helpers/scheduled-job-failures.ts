import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { SCHEDULED_JOB_FAILURES_QUEUE_NAME } from '../../config/scheduled-jobs-constants';

const SCHEDULED_JOB_FAILURES_IMPORT_ID = 'ScheduledJobFailuresQueueImport';

/**
 * The ScheduledJobFailures queue SharedInfraStack owns, resolved by name in the calling stack's account and
 * region (C1.1). Building the ARN locally, instead of passing the Queue across stacks, avoids an export
 * from SharedInfraStack and the dependency cycle a queue object would create.
 *
 * Imported, so CDK cannot add to its resource policy: the events-targets helper that normally lets
 * EventBridge write a rule's dead letters silently adds nothing here. SharedInfraStack writes that
 * statement by hand.
 *
 * Safe to call repeatedly: the import is created once per stack and reused.
 */
export const scheduledJobFailuresQueue = (scope: Construct): sqs.IQueue => {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild(SCHEDULED_JOB_FAILURES_IMPORT_ID);
  if (existing) {
    return existing as sqs.IQueue;
  }
  return sqs.Queue.fromQueueArn(
    stack,
    SCHEDULED_JOB_FAILURES_IMPORT_ID,
    stack.formatArn({ service: 'sqs', resource: SCHEDULED_JOB_FAILURES_QUEUE_NAME }),
  );
};

/**
 * A Lambda async OnFailure destination on the queue. Binding it grants the function's role
 * sqs:SendMessage (with GetQueueAttributes and GetQueueUrl) on the queue: Lambda sends the record with the
 * function's own role, so no queue policy is needed.
 */
export const scheduledJobFailureDestination = (scope: Construct): lambda.IDestination =>
  new lambdaDestinations.SqsDestination(scheduledJobFailuresQueue(scope));

/**
 * Lets an EventBridge Scheduler execution role write the schedule's dead letters: Scheduler sends to the
 * DLQ with the schedule's own role (EventBridge rules use the queue policy instead).
 */
export const grantScheduledJobFailuresSend = (role: iam.IRole): void => {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [scheduledJobFailuresQueue(role).queueArn],
    }),
  );
};
