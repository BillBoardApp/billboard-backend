import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AggregateDataStoreStack } from "../../lib/stacks/aggregate-data-store";
import { CongressStoreStack } from "../../lib/stacks/congress-store";
import { CongressIntegrationServiceStack } from "../../lib/stacks/congress-integration-service";
import { NotificationServiceStack } from "../../lib/stacks/notification-service";
import { SummarizerServiceStack } from "../../lib/stacks/summarizer-service";
import { UserAPIServiceStack } from "../../lib/stacks/user-api-service";
import { UserStoreStack } from "../../lib/stacks/user-store";
import { SharedInfraStack } from "../../lib/stacks/shared-infra";
import { MonitoringStack } from "../../lib/stacks/monitoring";
import { AnalyticsServiceStack } from "../../lib/stacks/analytics-service";
import {
  BILL_PRIORITY_TABLE_PARTITION_KEY,
} from "../../lib/config/priority-service-constants";
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import { createNamedQueue } from "./cdk-test-helpers";

export interface SynthesizedTemplates {
  analyticsTemplate: Template;
  congressTemplate: Template;
  userApiTemplate: Template;
  notificationTemplate: Template;
  summarizerTemplate: Template;
  congressStoreTemplate: Template;
  aggregateTemplate: Template;
  userStoreTemplate: Template;
  monitoringTemplate: Template;
}

// Synthesizing an app is the slow part of every test file, and a file usually
// reads one or two templates. Each template is therefore built on first read
// and cached for the rest of the module's life. Jest gives every test file its
// own module registry, so the cache lives for one test file on one worker;
// Template objects cannot be shared across files because each file loads its
// own copy of aws-cdk-lib.
const once = <T>(build: () => T): (() => T) => {
  let result: { value: T } | { error: unknown } | undefined;
  return () => {
    if (!result) {
      try {
        result = { value: build() };
      } catch (error) {
        // Cache the failure too, so a broken stack fails each test fast instead
        // of re-synthesizing for every assertion.
        result = { error };
      }
    }
    if ('error' in result) {
      throw result.error;
    }
    return result.value;
  };
};

// Each template is synthesized in its own isolated app to avoid inter-stack cycles.

const analyticsTemplate = once((): Template => {
  const appAnalytics = new cdk.App();
  const sharedA = new SharedInfraStack(appAnalytics, 'SharedInfraStack');
  const analyticsDeps = new cdk.Stack(appAnalytics, 'AnalyticsDeps');
  const feedbackTable = new ddb.Table(analyticsDeps, 'UserFeedbackTable', {
    partitionKey: { name: 'userId', type: ddb.AttributeType.STRING },
    sortKey: { name: 'billId', type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    stream: ddb.StreamViewType.NEW_IMAGE,
  });
  const analyticsStack = new AnalyticsServiceStack(appAnalytics, 'AnalyticsServiceStack', {
    lambdaArtifactsBucket: sharedA.lambdaArtifactsBucket,
    congressMemberStatsQueue: sharedA.congressMemberStatsQueue,
    feedbackTableStreamArn: feedbackTable.tableStreamArn!,
    enableFeedbackStreamAggregation: false,
  });
  return Template.fromStack(analyticsStack);
});

// The store stacks take no Lambda functions (CQ-15), so each one needs only what it owns.
const congressStoreTemplate = once((): Template => {
  const appCongress = new cdk.App();
  const sharedC = new SharedInfraStack(appCongress, 'SharedInfraStack');
  const congressStoreStack = new CongressStoreStack(appCongress, 'CongressStoreStack', {
    lambdaArtifactsBucket: sharedC.lambdaArtifactsBucket,
    notificationTypeQueue: sharedC.notificationTypeQueue,
    congressMemberStatsQueue: sharedC.congressMemberStatsQueue,
  });
  return Template.fromStack(congressStoreStack);
});

const aggregateTemplate = once((): Template =>
  Template.fromStack(new AggregateDataStoreStack(new cdk.App(), 'AggregateDataStoreStack')),
);

const congressTemplate = once((): Template => {
  const appNews = new cdk.App();
  const sharedNews = new SharedInfraStack(appNews, 'SharedInfraStack');
  return Template.fromStack(new CongressIntegrationServiceStack(appNews, 'CongressIntegrationServiceStack', { lambdaArtifactsBucket: sharedNews.lambdaArtifactsBucket }));
});

const userApiTemplate = once((): Template => {
  const appUserApi = new cdk.App();
  const sharedUserApi = new SharedInfraStack(appUserApi, 'SharedInfraStack');
  const userApiDeps = new cdk.Stack(appUserApi, 'UserApiDeps');
  const billPriorityTableForUserApi = new ddb.Table(userApiDeps, 'BillPriorityTable', {
    partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  });
  const userApiStack = new UserAPIServiceStack(appUserApi, 'UserAPIServiceStack', {
    lambdaArtifactsBucket: sharedUserApi.lambdaArtifactsBucket,
    billPriorityTable: billPriorityTableForUserApi,
  });
  return Template.fromStack(userApiStack);
});

const notificationTemplate = once((): Template => {
  const appNotification = new cdk.App();
  const sharedNotif = new SharedInfraStack(appNotification, 'SharedInfraStack');
  const notificationDeps = new cdk.Stack(appNotification, 'NotificationDeps');
  const billPriorityTableForNotifications = new ddb.Table(notificationDeps, 'BillPriorityTable', {
    partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  });
  const notificationStack = new NotificationServiceStack(appNotification, 'NotificationServiceStack', {
    lambdaArtifactsBucket: sharedNotif.lambdaArtifactsBucket,
    notificationTypeQueue: sharedNotif.notificationTypeQueue,
    billPriorityTable: billPriorityTableForNotifications,
  });
  return Template.fromStack(notificationStack);
});

const summarizerTemplate = once((): Template => {
  const appSummarizer = new cdk.App();
  const sharedSum = new SharedInfraStack(appSummarizer, 'SharedInfraStack');
  const sumDeps = new cdk.Stack(appSummarizer, 'SumDeps');
  const billDifferQueue = createNamedQueue(sumDeps, 'BillDifferQueue');
  const congressMemberSummarizerQueue = createNamedQueue(sumDeps, 'CongressMemberSummarizerQueue');
  const summarizerStack = new SummarizerServiceStack(appSummarizer, 'SummarizerServiceStack', {
    billDifferQueue,
    congressMemberSummarizerQueue,
    lambdaArtifactsBucket: sharedSum.lambdaArtifactsBucket,
  });
  return Template.fromStack(summarizerStack);
});

const userStoreTemplate = once((): Template =>
  Template.fromStack(new UserStoreStack(new cdk.App(), 'UserStoreStack')),
);

const monitoringTemplate = once((): Template => {
  const appMonitoring = new cdk.App();
  const monitoringStack = new MonitoringStack(appMonitoring, 'MonitoringStack');
  return Template.fromStack(monitoringStack);
});

// Same object every call; each property synthesizes its stack on first read.
const synthesizedTemplates: SynthesizedTemplates = {
  get analyticsTemplate() { return analyticsTemplate(); },
  get congressTemplate() { return congressTemplate(); },
  get userApiTemplate() { return userApiTemplate(); },
  get notificationTemplate() { return notificationTemplate(); },
  get summarizerTemplate() { return summarizerTemplate(); },
  get congressStoreTemplate() { return congressStoreTemplate(); },
  get aggregateTemplate() { return aggregateTemplate(); },
  get userStoreTemplate() { return userStoreTemplate(); },
  get monitoringTemplate() { return monitoringTemplate(); },
};

export const synthesizeStacks = (): SynthesizedTemplates => synthesizedTemplates;
