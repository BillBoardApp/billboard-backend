import { generateKeyPairSync, KeyObject } from "node:crypto";
import * as cdk from "aws-cdk-lib";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  BACKFILL_PUSH_MODE,
  DISPATCH_SHARD_COUNT,
  NOTIFICATION_FANOUT_ENABLED,
  PUSH_PACE_HOURS,
  QUIET_HOURS_ENABLED,
} from "../lib/config/notification-service-constants";
import { NotificationServiceStack, USER_NOTIFIER_PENDING_EXPIRY_MODE } from "../lib/stacks/notification-service";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { isDataWrite, leadingKeysCondition, partitionScopedGrants, storeActions } from "./helpers/cdk-test-helpers";
import { synthesizeStacks } from "./helpers/synth-stacks";
import { BILL_STORE_BUCKET_NAME } from "../lib/config/deployment-identity";

const templates = synthesizeStacks();

describe("NotificationServiceStack", () => {
  test("exposes queues, topic, and worker lambdas", () => {
    templates.notificationTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "userMatcherQueue",
      VisibilityTimeout: 180,
    });

    templates.notificationTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "userNotifierQueue",
    });

    // SNS topic removed from the stack in the updated infra

    // The stack includes at least the two worker lambdas; additional lambdas may
    // be present (e.g., CDK custom resource providers).
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "UserMatcher",
      Timeout: 30,
    });
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "UserNotifier",
    });
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "NotificationDispatcher",
      Environment: {
        Variables: Match.objectLike({
          PARTITION_KEY: "userId",
          PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "guid",
        }),
      },
    });
    templates.notificationTemplate.resourceCountIs("AWS::Lambda::EventSourceMapping", 4);
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: Match.objectLike({
        "Fn::GetAtt": Match.arrayWith([
          Match.stringLikeRegexp("userMatcherQueue"),
          "Arn",
        ]),
      }),
      BatchSize: 5,
      Enabled: true,
    });
  });

  // C1.7: no bucket notification targets NotificationTypeQueue (only CongressMemberStatsQueue and the
  // manifest queue are S3 targets), and CreateBillsManifest sends to it through IAM, so the S3 queue policy
  // was orphaned. The queue lives in SharedInfraStack and is left without a policy.
  test("sets no queue policy: S3 no longer may send to NotificationTypeQueue", () => {
    templates.notificationTemplate.resourceCountIs("AWS::SQS::QueuePolicy", 0);
    expect(JSON.stringify(templates.notificationTemplate.toJSON())).not.toContain("s3.amazonaws.com");
  });

  // X6: the expired-push cutoff (C1.3) shipped watch-only and now enforces: UserNotifier deletes rows past their
  // 24-hour lifetime unsent. "watch" (count and log them, still send them) is the rollback.
  test("UserNotifier runs the expired-push cutoff in enforce mode", () => {
    expect(USER_NOTIFIER_PENDING_EXPIRY_MODE).toBe("enforce");
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "UserNotifier",
      Environment: { Variables: Match.objectLike({ PENDING_EXPIRY_MODE: "enforce" }) },
    });
    // Only UserNotifier reads it.
    const withMode = Object.values(templates.notificationTemplate.findResources("AWS::Lambda::Function"))
      .filter((fn) => fn.Properties.Environment?.Variables?.PENDING_EXPIRY_MODE !== undefined)
      .map((fn) => fn.Properties.FunctionName);
    expect(withMode).toEqual(["UserNotifier"]);
  });

  // REL-56 (docs/RUNBOOK.md 16.1): a change the backfill wrote (a rel56: correlation id) is handed to nobody, so the
  // backfill runs without quiet windows. 'push' is the rollback.
  test("NotificationType skips the backfill's pushes (BACKFILL_PUSH_MODE)", () => {
    expect(BACKFILL_PUSH_MODE).toBe("skip");
    templates.notificationTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "NotificationType",
      Environment: { Variables: Match.objectLike({ BACKFILL_PUSH_MODE: "skip" }) },
    });
    // EMF only: BackfillPushSkipped needs no PutMetricData grant.
    expect(JSON.stringify(roleStatements("NotificationType"))).not.toContain("cloudwatch:PutMetricData");
  });

  test("grants dispatcher table writes and notifier endpoint publish access", () => {
    templates.notificationTemplate.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:PutItem"]),
            Effect: "Allow",
            Resource: Match.arrayWith([
              Match.objectLike({
                "Fn::GetAtt": Match.arrayWith([
                  Match.stringLikeRegexp("PendingNotificationsTable"),
                  "Arn",
                ]),
              }),
            ]),
          }),
        ]),
      }),
    });

    const policies = templates.notificationTemplate.findResources("AWS::IAM::Policy");
    const policyJson = JSON.stringify(policies);
    expect(policyJson).toContain('"Action":"sns:Publish"');
    expect(policyJson).toContain(':app/APNS/BillboardApnsProduction');
    expect(policyJson).toContain(':endpoint/APNS/BillboardApnsProduction/*');
  });
});

// ── Reliability settings (REL-01..04, REL-18, SEC-04, REC-01, REC-04) ────────

type CfnResource = { Properties: Record<string, any> };

const notificationTemplate = () => templates.notificationTemplate;

function singleResource(
  type: string,
  properties: Record<string, unknown>,
  template: Template = notificationTemplate(),
): { id: string; props: Record<string, any> } {
  const found = Object.entries(
    template.findResources(type, { Properties: properties }) as Record<string, CfnResource>,
  );
  expect(found).toHaveLength(1);
  const [[id, resource]] = found;
  return { id, props: resource.Properties };
}

const functionByName = (name: string, template?: Template) =>
  singleResource("AWS::Lambda::Function", { FunctionName: name }, template);
const queueByName = (name: string, template?: Template) =>
  singleResource("AWS::SQS::Queue", { QueueName: name }, template);

function roleStatements(functionName: string, template: Template = notificationTemplate()): Record<string, any>[] {
  const roleId = functionByName(functionName, template).props.Role["Fn::GetAtt"][0];
  const policies = Object.values(
    template.findResources("AWS::IAM::Policy") as Record<string, CfnResource>,
  );
  return policies
    .filter((policy) => policy.Properties.Roles.some((role: { Ref?: string }) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: Record<string, any>): string[] => [statement.Action].flat();

describe("NotificationServiceStack reliability", () => {
  test("sets explicit timeouts on every notification worker", () => {
    expect(functionByName("NotificationType").props.Timeout).toBe(30);
    expect(functionByName("UserMatcher").props.Timeout).toBe(30);
    expect(functionByName("UserNotifier").props.Timeout).toBe(120);
    expect(functionByName("NotificationDispatcher").props.Timeout).toBe(60);
    expect(functionByName("NotificationFanout").props.Timeout).toBe(60);
  });

  test.each([
    ["userMatcherQueue", "UserMatcher"],
    ["notificationFanoutQueue", "NotificationFanout"],
    ["userNotifierQueue", "UserNotifier"],
  ])("%s visibility timeout is at least six times the %s timeout", (queueName, functionName) => {
    const timeout = functionByName(functionName).props.Timeout;
    expect(queueByName(queueName).props.VisibilityTimeout).toBeGreaterThanOrEqual(6 * timeout);
  });

  test.each([
    ["userMatcherQueue", "userMatcherDLQ"],
    ["notificationFanoutQueue", "notificationFanoutDLQ"],
    ["userNotifierQueue", "userNotifierDLQ"],
  ])("%s redrives to %s after five receives", (queueName, dlqName) => {
    const dlq = queueByName(dlqName);
    expect(dlq.props.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
    expect(queueByName(queueName).props.RedrivePolicy).toEqual({
      deadLetterTargetArn: { "Fn::GetAtt": [dlq.id, "Arn"] },
      maxReceiveCount: 5,
    });
  });

  test("every SQS event source mapping reports batch item failures", () => {
    const mappings = Object.entries(
      notificationTemplate().findResources("AWS::Lambda::EventSourceMapping") as Record<string, CfnResource>,
    );
    expect(mappings).toHaveLength(4);
    for (const [id, mapping] of mappings) {
      expect({ id, types: mapping.Properties.FunctionResponseTypes }).toEqual({
        id,
        types: ["ReportBatchItemFailures"],
      });
    }
  });

  test("deploys every worker all at once", () => {
    const groups = Object.values(
      notificationTemplate().findResources("AWS::CodeDeploy::DeploymentGroup") as Record<string, CfnResource>,
    );
    expect(groups).toHaveLength(5);
    for (const group of groups) {
      expect(group.Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaAllAtOnce");
    }
    notificationTemplate().resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
  });

  test("protects the pending notifications table from deletion", () => {
    notificationTemplate().hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PendingNotificationsTable",
      DeletionProtectionEnabled: true,
    });
  });

  test("APNs secret keeps the value settings it was deployed with", () => {
    // Changing GenerateSecretString, or adding SecretString, makes
    // CloudFormation write a new version over the hand-seeded production
    // credentials. The custom resource handles a fresh stack's random value.
    notificationTemplate().hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "Billboard/ApnsCredentials",
      GenerateSecretString: Match.exact({}),
      SecretString: Match.absent(),
    });
  });

  test("lets the dispatcher read the APNs certificate expiry and publish its metric", () => {
    const dispatcher = functionByName("NotificationDispatcher");
    const applicationArn = dispatcher.props.Environment.Variables.APNS_PLATFORM_APPLICATION_ARN;
    expect(JSON.stringify(applicationArn)).toMatch(/:sns:.*:app\/APNS\/BillboardApnsProduction"\]\]\}$/);

    const statements = roleStatements("NotificationDispatcher");
    const readAttributes = statements.filter(
      (statement) => statement.Action === "sns:GetPlatformApplicationAttributes",
    );
    expect(readAttributes).toHaveLength(1);
    expect(readAttributes[0].Effect).toBe("Allow");
    expect(readAttributes[0].Resource).toEqual(applicationArn);

    expect(statements).toContainEqual({
      Action: "cloudwatch:PutMetricData",
      Effect: "Allow",
      Resource: "*",
      Condition: { StringEquals: { "cloudwatch:namespace": "BillBoard/Notifications" } },
    });
  });
});

// ── Notification fan-out and dispatch shards (CAP-02) ────────────────────────

// The same stack with the NOTIFICATION_FANOUT_ENABLED rollback switch flipped off.
let fanoutDisabledTemplateCache: Template | undefined;
const fanoutDisabledTemplate = (): Template => {
  if (!fanoutDisabledTemplateCache) {
    const app = new cdk.App();
    const shared = new SharedInfraStack(app, "SharedInfraStack");
    const deps = new cdk.Stack(app, "NotificationDeps");
    const billPriorityTable = new ddb.Table(deps, "BillPriorityTable", {
      partitionKey: { name: "guid", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });
    const stack = new NotificationServiceStack(app, "NotificationServiceStack", {
      lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
      notificationTypeQueue: shared.notificationTypeQueue,
      billPriorityTable,
      notificationFanoutEnabled: !NOTIFICATION_FANOUT_ENABLED,
    });
    fanoutDisabledTemplateCache = Template.fromStack(stack);
  }
  return fanoutDisabledTemplateCache;
};

describe("NotificationServiceStack fan-out and dispatch shards (CAP-02)", () => {
  const pendingTableArn = () => ({
    "Fn::GetAtt": [singleResource("AWS::DynamoDB::Table", { TableName: "PendingNotificationsTable" }).id, "Arn"],
  });
  const queueArn = (queueName: string, template?: Template) => ({
    "Fn::GetAtt": [queueByName(queueName, template).id, "Arn"],
  });
  const sendsTo = (functionName: string, queueName: string, template?: Template): boolean =>
    roleStatements(functionName, template).some((statement) =>
      actionsOf(statement).includes("sqs:SendMessage")
      && JSON.stringify(statement.Resource) === JSON.stringify(queueArn(queueName, template)));

  test("fan-out is on by default", () => {
    expect(NOTIFICATION_FANOUT_ENABLED).toBe(true);
  });

  test("gives all four notification functions the same dispatch shard count", () => {
    expect(DISPATCH_SHARD_COUNT).toBe(8);
    const shardCounts = ["UserMatcher", "NotificationFanout", "NotificationDispatcher", "UserNotifier"].map(
      (functionName) => functionByName(functionName).props.Environment.Variables.DISPATCH_SHARD_COUNT,
    );
    expect(shardCounts).toEqual(["8", "8", "8", "8"]);
  });

  test("creates NotificationFanout with only the pending-notification writer settings", () => {
    const fanout = functionByName("NotificationFanout");
    expect(fanout.props.Timeout).toBe(60);
    expect(fanout.props.MemorySize).toBe(256);
    expect(fanout.props.Environment.Variables).toEqual({
      PENDING_NOTIFICATIONS_TABLE: { Ref: singleResource("AWS::DynamoDB::Table", { TableName: "PendingNotificationsTable" }).id },
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "guid",
      PREFERENCE_TABLE: "UserPreferences",
      USER_ID_ATTRIBUTE: "userId",
      SUB_CATEGORY_ATTRIBUTE: "preference",
      DISPATCH_SHARD_COUNT: "8",
    });

    // The writer settings match UserMatcher's inline path exactly.
    const matcherVariables = functionByName("UserMatcher").props.Environment.Variables;
    Object.entries(fanout.props.Environment.Variables).forEach(([name, value]) => {
      expect({ name, value: matcherVariables[name] }).toEqual({ name, value });
    });
  });

  test("encrypts the fan-out queue and its DLQ, and keeps dead letters 14 days", () => {
    expect(queueByName("notificationFanoutQueue").props).toEqual(expect.objectContaining({
      VisibilityTimeout: 360,
      SqsManagedSseEnabled: true,
    }));
    expect(queueByName("notificationFanoutDLQ").props).toEqual(expect.objectContaining({
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
    }));
  });

  test("consumes the fan-out queue from the prod alias, 5 messages at a time, at most 2 at once", () => {
    const mapping = singleResource("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: queueArn("notificationFanoutQueue"),
    });
    expect(mapping.props).toEqual(expect.objectContaining({
      BatchSize: 5,
      Enabled: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 2 },
    }));
    expect(mapping.props.MaximumBatchingWindowInSeconds).toBeUndefined();
    // "<function name>:prod", taken from the prod alias.
    expect(JSON.stringify(mapping.props.FunctionName)).toMatch(/"Ref":"NotificationFanoutProdAlias[^"]*"\}\]\}\]\},":prod"/);
  });

  test("NotificationFanout may only consume its queue, PutItem into PendingNotifications and Query UserPreferences", () => {
    const statements = roleStatements("NotificationFanout");
    const dynamoStatements = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith("dynamodb:")));
    expect(dynamoStatements).toEqual([
      { Action: "dynamodb:PutItem", Effect: "Allow", Resource: [pendingTableArn()] },
      expect.objectContaining({ Action: "dynamodb:Query", Effect: "Allow" }),
    ]);
    // The content-type filter reads one user's preference rows: a base-table Query, no index.
    expect(storeActions(statements)).toEqual({ "table/UserPreferences": ["dynamodb:Query"] });

    const sqsStatements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("sqs:")));
    expect(sqsStatements.length).toBeGreaterThan(0);
    sqsStatements.forEach((statement) => {
      expect(statement.Resource).toEqual(queueArn("notificationFanoutQueue"));
      expect(actionsOf(statement)).not.toContain("sqs:SendMessage");
    });

    const otherActions = statements
      .flatMap(actionsOf)
      .filter((action) => !/^(dynamodb|sqs|xray):/.test(action));
    expect(otherActions).toEqual([]);
  });

  test("UserMatcher sends matched users to the fan-out queue and keeps its inline write access", () => {
    const variables = functionByName("UserMatcher").props.Environment.Variables;
    expect(variables.NOTIFICATION_FANOUT_QUEUE_URL).toEqual({ Ref: queueByName("notificationFanoutQueue").id });
    expect(sendsTo("UserMatcher", "notificationFanoutQueue")).toBe(true);
    expect(roleStatements("UserMatcher").some((statement) =>
      actionsOf(statement).includes("dynamodb:PutItem")
      && JSON.stringify(statement.Resource).includes(JSON.stringify(pendingTableArn())))).toBe(true);
  });

  // APPF-23: the current UserMatcher claims a pair's "new" deferral with a conditional PutItem of a
  // `companion-new||<House guid>` row in the `__dedupe__` partition (claimCompanionNewDeferral). So the
  // write grant is not only for the inline path: it must stay, unrestricted to user partitions, with
  // fan-out on or off. Without it every claim fails and users both members match get two "new" pushes.
  test("UserMatcher keeps PutItem on PendingNotificationsTable for the companion new claim, fan-out on or off", () => {
    [notificationTemplate(), fanoutDisabledTemplate()].forEach((template) => {
      const tableArn = JSON.stringify({
        "Fn::GetAtt": [singleResource("AWS::DynamoDB::Table", { TableName: "PendingNotificationsTable" }, template).id, "Arn"],
      });
      const claimGrants = roleStatements("UserMatcher", template).filter((statement) =>
        statement.Effect === "Allow"
        && actionsOf(statement).includes("dynamodb:PutItem")
        && JSON.stringify(statement.Resource).includes(tableArn));
      expect(claimGrants.length).toBeGreaterThan(0);
      // A LeadingKeys condition limited to user partitions would deny the claim row.
      const allowsDedupePartition = claimGrants.some((statement) => {
        const leadingKeys = statement.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"];
        return statement.Condition === undefined || [leadingKeys].flat().includes("__dedupe__");
      });
      expect(allowsDedupePartition).toBe(true);
    });
  });

  test("with the switch off, UserMatcher writes inline and the fan-out resources stay in place", () => {
    const template = fanoutDisabledTemplate();
    const variables = functionByName("UserMatcher", template).props.Environment.Variables;
    expect(variables.NOTIFICATION_FANOUT_QUEUE_URL).toBeUndefined();
    expect(variables.DISPATCH_SHARD_COUNT).toBe("8");
    // The send grant stays: IAM is not versioned, and the UserMatcher version still live until its
    // alias shifts (or after a rollback) was published with the queue URL.
    expect(sendsTo("UserMatcher", "notificationFanoutQueue", template)).toBe(true);

    // Queue, DLQ, function and its mapping exist either way, so flipping back is one deploy.
    queueByName("notificationFanoutDLQ", template);
    functionByName("NotificationFanout", template);
    singleResource("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: queueArn("notificationFanoutQueue", template),
    }, template);
    template.resourceCountIs("AWS::CodeDeploy::DeploymentGroup", 5);
  });
});

// ── APNs platform application custom resource ────────────────────────────────

// CQ-15: the store tables and bucket are referenced by their fixed names, not through exports.
describe("NotificationServiceStack data store access", () => {
  const storeAccessOf = (functionName: string) => storeActions(roleStatements(functionName));
  const writesOf = (functionName: string) => Object.values(storeAccessOf(functionName)).flat().filter(isDataWrite);

  test("UserMatcher reads preferences (and the sub-category index), UserPII, the bill store and BillsManifest", () => {
    expect(Object.keys(storeAccessOf("UserMatcher"))).toEqual([
      `bucket/${BILL_STORE_BUCKET_NAME}`,
      `bucket/${BILL_STORE_BUCKET_NAME}/*`,
      "table/BillsManifest",
      "table/UserPII",
      "table/UserPreferences",
      "table/UserPreferences/index/*",
    ]);
    expect(writesOf("UserMatcher")).toEqual([]);
    expect(functionByName("UserMatcher").props.Environment.Variables).toEqual(expect.objectContaining({
      PII_TABLE_NAME: "UserPII",
      PII_PARTITION_KEY: "userId",
    }));
  });

  test("NotificationType reads the bill store and UserNotifier reads and writes UserDevices", () => {
    expect(Object.keys(storeAccessOf("NotificationType"))).toEqual([
      `bucket/${BILL_STORE_BUCKET_NAME}`,
      `bucket/${BILL_STORE_BUCKET_NAME}/*`,
    ]);
    expect(writesOf("NotificationType")).toEqual([]);
    expect(storeAccessOf("UserNotifier")["table/UserDevices"]).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"]),
    );
    expect(Object.keys(storeAccessOf("UserNotifier"))).toEqual([
      "table/BillsManifest",
      "table/UserDevices",
      "table/UserDevices/index/*",
      "table/UserFeedback",
      "table/UserPII",
    ]);
  });

  // S5: the quiet hours read the user's state from UserPII, one GetItem of their own row, and write nothing there.
  test("UserNotifier holds pushes for the quiet hours and may only GetItem UserPII", () => {
    expect(QUIET_HOURS_ENABLED).toBe(true);
    expect(functionByName("UserNotifier").props.Environment.Variables).toEqual(expect.objectContaining({
      QUIET_HOURS: "on",
      PII_TABLE_NAME: "UserPII",
      PII_PARTITION_KEY: "userId",
    }));
    expect(storeAccessOf("UserNotifier")["table/UserPII"]).toEqual(["dynamodb:GetItem"]);
    // Only UserNotifier reads the switch.
    const withSwitch = Object.values(templates.notificationTemplate.findResources("AWS::Lambda::Function"))
      .filter((fn) => fn.Properties.Environment?.Variables?.QUIET_HOURS !== undefined)
      .map((fn) => fn.Properties.FunctionName);
    expect(withSwitch).toEqual(["UserNotifier"]);
  });

  // UX-33: at most one push every 3 hours, and no "vote again" push after a newer vote: the time of the user's own vote
  // on the bill, one GetItem, and nothing else in UserFeedback (no index, no stream, no write).
  test("UserNotifier paces pushes and may only GetItem UserFeedback", () => {
    expect(PUSH_PACE_HOURS).toBe(3);
    expect(functionByName("UserNotifier").props.Environment.Variables).toEqual(expect.objectContaining({
      PUSH_PACE_HOURS: "3",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
    }));
    expect(storeAccessOf("UserNotifier")["table/UserFeedback"]).toEqual(["dynamodb:GetItem"]);
    // Only UserNotifier reads them.
    const withPace = Object.values(templates.notificationTemplate.findResources("AWS::Lambda::Function"))
      .filter((fn) => fn.Properties.Environment?.Variables?.PUSH_PACE_HOURS !== undefined
        || fn.Properties.Environment?.Variables?.FEEDBACK_TABLE_NAME !== undefined)
      .map((fn) => fn.Properties.FunctionName);
    expect(withPace).toEqual(["UserNotifier"]);
  });

  // APPF-23 companion bills. Neither function had BillsManifest access before; each reaches only the
  // partitions it needs, with no Scan and no writes.
  const companionEnvironment = {
    MANIFEST_TABLE_NAME: "BillsManifest",
    MANIFEST_PRIMARY_KEY: "pk",
    MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
    MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
    GUID_LOOKUP_PK: "BILL_GUID",
  };
  const manifestStatements = (functionName: string) => roleStatements(functionName)
    .filter((statement) => JSON.stringify(statement.Resource).includes("table/BillsManifest"));

  // Exactly the reads it makes: GetItem of the groups row and of BILL_GUID lookup rows (updatedAt),
  // Query of the link lists and BatchGetItem of BILL_GUID lookup rows (held checks). No BILL rows.
  test("UserMatcher reads the companion rows and the BILL_GUID lookup rows, each only as it needs, and nothing else in BillsManifest", () => {
    expect(manifestStatements("UserMatcher")).toHaveLength(3);
    expect(partitionScopedGrants(roleStatements("UserMatcher"))).toEqual([
      { resource: "table/BillsManifest", actions: ["dynamodb:GetItem"], condition: leadingKeysCondition("BILL_COMPANION_GROUPS", "BILL_GUID") },
      { resource: "table/BillsManifest", actions: ["dynamodb:Query"], condition: leadingKeysCondition("BILL_COMPANION_DECL") },
      { resource: "table/BillsManifest", actions: ["dynamodb:BatchGetItem"], condition: leadingKeysCondition("BILL_GUID") },
    ]);
    const variables = functionByName("UserMatcher").props.Environment.Variables;
    expect(variables).toEqual(expect.objectContaining(companionEnvironment));
    expect(variables.COMPANION_GROUPS_ENABLED).toBeUndefined();
  });

  test("UserNotifier may only GetItem the companion groups row in BillsManifest", () => {
    expect(manifestStatements("UserNotifier")).toHaveLength(1);
    expect(partitionScopedGrants(roleStatements("UserNotifier"))).toEqual([
      { resource: "table/BillsManifest", actions: ["dynamodb:GetItem"], condition: leadingKeysCondition("BILL_COMPANION_GROUPS") },
    ]);
    expect(functionByName("UserNotifier").props.Environment.Variables).toEqual(expect.objectContaining(companionEnvironment));
  });

  test("NotificationType, NotificationFanout and NotificationDispatcher get no companion access", () => {
    ["NotificationType", "NotificationFanout", "NotificationDispatcher"].forEach((functionName) => {
      expect({ functionName, statements: manifestStatements(functionName) }).toEqual({ functionName, statements: [] });
      expect({ functionName, key: functionByName(functionName).props.Environment.Variables.MANIFEST_COMPANION_GROUPS_PK })
        .toEqual({ functionName, key: undefined });
    });
  });
});

describe("APNs platform application custom resource", () => {
  const SENTINEL = "do-not-log-this-value";
  const CERT = "-----BEGIN CERTIFICATE-----\nMIIBfakecert\n-----END CERTIFICATE-----";
  const KEY = "-----BEGIN PRIVATE KEY-----\nMIIEfakekey\n-----END PRIVATE KEY-----";
  const APP_ARN = "arn:aws:sns:us-east-1:123456789012:app/APNS/BillboardApnsProduction";
  const properties = { SecretId: "Billboard/ApnsCredentials", ApplicationName: "BillboardApnsProduction" };

  type SentCommand = { name: string; input: Record<string, any> };
  type Handler = (event: Record<string, unknown>) => Promise<Record<string, any>>;

  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** Loads index.js with the AWS SDK clients replaced by in-memory fakes. `snsError` makes every SNS call fail. */
  function loadHandler(
    getSecretValue: () => Promise<unknown>,
    snsError?: Error,
  ): { handler: Handler; snsCommands: SentCommand[] } {
    const snsCommands: SentCommand[] = [];
    const command = (name: string) =>
      class {
        readonly commandName = name;
        constructor(readonly input: Record<string, any>) {}
      };
    let handler: Handler | undefined;
    jest.isolateModules(() => {
      jest.doMock("@aws-sdk/client-sns", () => ({
        SNSClient: class {
          async send(cmd: { commandName: string; input: Record<string, any> }) {
            snsCommands.push({ name: cmd.commandName, input: cmd.input });
            if (snsError) throw snsError;
            return cmd.commandName === "CreatePlatformApplicationCommand"
              ? { PlatformApplicationArn: APP_ARN }
              : {};
          }
        },
        CreatePlatformApplicationCommand: command("CreatePlatformApplicationCommand"),
        SetPlatformApplicationAttributesCommand: command("SetPlatformApplicationAttributesCommand"),
        DeletePlatformApplicationCommand: command("DeletePlatformApplicationCommand"),
      }));
      jest.doMock("@aws-sdk/client-secrets-manager", () => ({
        SecretsManagerClient: class {
          send = getSecretValue;
        },
        GetSecretValueCommand: command("GetSecretValueCommand"),
      }));
      handler = require("../lib/custom_resources/apns-platform-application-on-event/index.js").handler;
    });
    return { handler: handler!, snsCommands };
  }

  const secretString = (value: string) => () => Promise.resolve({ SecretString: value });
  const loggedText = () => JSON.stringify(logSpy.mock.calls);

  test.each([
    ["a random generated string", secretString(`${SENTINEL}!#$%`)],
    ["an empty JSON object", secretString("{}")],
    ["JSON null", secretString("null")],
    ["a JSON array", secretString(`["${SENTINEL}"]`)],
    ["non-PEM credential fields", secretString(JSON.stringify({ certificate: SENTINEL, privateKey: SENTINEL }))],
    ["no string value", () => Promise.resolve({})],
    [
      "no AWSCURRENT version",
      () => Promise.reject(Object.assign(new Error("no value"), { name: "ResourceNotFoundException" })),
    ],
  ])("Create with %s succeeds without creating the application", async (_label, getSecretValue) => {
    const { handler, snsCommands } = loadHandler(getSecretValue);

    await expect(handler({ RequestType: "Create", ResourceProperties: properties })).resolves.toEqual({
      PhysicalResourceId: "none",
      Data: { PlatformApplicationArn: "" },
    });
    expect(snsCommands).toEqual([]);
    expect(loggedText()).toContain("not configured yet");
    expect(loggedText()).not.toContain(SENTINEL);
  });

  test("Update of an existing application with unusable credentials keeps it unchanged", async () => {
    const { handler, snsCommands } = loadHandler(secretString(SENTINEL));

    await expect(
      handler({
        RequestType: "Update",
        PhysicalResourceId: APP_ARN,
        ResourceProperties: properties,
        OldResourceProperties: properties,
      }),
    ).resolves.toEqual({ PhysicalResourceId: APP_ARN, Data: { PlatformApplicationArn: APP_ARN } });
    expect(snsCommands).toEqual([]);
    expect(loggedText()).not.toContain(SENTINEL);
  });

  test("Create with PEM credentials creates the application from the PEM blocks only", async () => {
    const { handler, snsCommands } = loadHandler(
      secretString(JSON.stringify({ certificate: `Bag Attributes\n${CERT}\n`, privateKey: KEY })),
    );

    await expect(handler({ RequestType: "Create", ResourceProperties: properties })).resolves.toEqual({
      PhysicalResourceId: APP_ARN,
      Data: { PlatformApplicationArn: APP_ARN },
    });
    expect(snsCommands).toEqual([
      {
        name: "CreatePlatformApplicationCommand",
        input: {
          Name: "BillboardApnsProduction",
          Platform: "APNS",
          Attributes: { PlatformPrincipal: CERT, PlatformCredential: KEY },
        },
      },
    ]);
  });

  test("Update with PEM credentials rotates the existing application's attributes", async () => {
    const { handler, snsCommands } = loadHandler(
      secretString(JSON.stringify({ PlatformPrincipal: CERT, PlatformCredential: KEY })),
    );

    await handler({
      RequestType: "Update",
      PhysicalResourceId: APP_ARN,
      ResourceProperties: properties,
      OldResourceProperties: properties,
    });
    expect(snsCommands).toEqual([
      {
        name: "SetPlatformApplicationAttributesCommand",
        input: {
          PlatformApplicationArn: APP_ARN,
          Attributes: { PlatformPrincipal: CERT, PlatformCredential: KEY },
        },
      },
    ]);
  });

  test("other Secrets Manager errors still fail the deployment", async () => {
    const { handler } = loadHandler(() =>
      Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })),
    );

    await expect(handler({ RequestType: "Create", ResourceProperties: properties })).rejects.toThrow("denied");
  });

  test("SNS refusing certificate credentials still fails the deployment, as before", async () => {
    const { handler } = loadHandler(
      secretString(JSON.stringify({ PlatformPrincipal: CERT, PlatformCredential: KEY })),
      Object.assign(new Error("Invalid parameter"), { name: "InvalidParameterException" }),
    );

    await expect(
      handler({
        RequestType: "Update",
        PhysicalResourceId: APP_ARN,
        ResourceProperties: properties,
        OldResourceProperties: properties,
      }),
    ).rejects.toThrow("Invalid parameter");
  });

  // UA-08: an APNs auth key (.p8) instead of the certificate that expires 2027-01-27.
  describe("token-based (.p8) credentials", () => {
    const pkcs8 = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString().trim();
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    // Apple's own fictional IDs from its token documentation, and a reserved example domain.
    const SIGNING_KEY = pkcs8(p256);
    const KEY_ID = "ABC123DEFG";
    const TEAM_ID = "DEF123GHIJ";
    const BUNDLE_ID = "com.example.app";
    const TOKEN_SECRET = { SigningKey: `${SIGNING_KEY}\n`, SigningKeyId: KEY_ID, TeamId: TEAM_ID, BundleId: BUNDLE_ID };
    const TOKEN_ATTRIBUTES = {
      PlatformCredential: SIGNING_KEY,
      PlatformPrincipal: KEY_ID,
      ApplePlatformTeamID: TEAM_ID,
      ApplePlatformBundleID: BUNDLE_ID,
    };
    const updateEvent = {
      RequestType: "Update",
      PhysicalResourceId: APP_ARN,
      ResourceProperties: { ...properties, SyncToken: "2026-12-01-1" },
      OldResourceProperties: { ...properties, SyncToken: "2025-12-28-3" },
    };

    /** Every line of every value in the secret (PEM armor aside) must stay out of the logs. */
    const expectNoSecretInLogs = (secret: Record<string, unknown>) => {
      const lines = Object.values(secret)
        .flatMap((value) => String(value).split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length >= 8 && !line.startsWith("-----"));
      expect(lines.length).toBeGreaterThan(0);
      const logged = loggedText();
      for (const line of lines) expect(logged).not.toContain(line);
    };

    test("Create with a token secret creates the application with the four token attributes", async () => {
      const { handler, snsCommands } = loadHandler(secretString(JSON.stringify(TOKEN_SECRET)));

      await expect(handler({ RequestType: "Create", ResourceProperties: properties })).resolves.toEqual({
        PhysicalResourceId: APP_ARN,
        Data: { PlatformApplicationArn: APP_ARN },
      });
      expect(snsCommands).toEqual([
        {
          name: "CreatePlatformApplicationCommand",
          input: { Name: "BillboardApnsProduction", Platform: "APNS", Attributes: TOKEN_ATTRIBUTES },
        },
      ]);
      expect(loggedText()).toContain("with token credentials");
      expectNoSecretInLogs(TOKEN_SECRET);
    });

    test("Update switches an existing certificate application to token credentials in place", async () => {
      const { handler, snsCommands } = loadHandler(secretString(JSON.stringify(TOKEN_SECRET)));

      await expect(handler(updateEvent)).resolves.toEqual({
        PhysicalResourceId: APP_ARN,
        Data: { PlatformApplicationArn: APP_ARN },
      });
      expect(snsCommands).toEqual([
        {
          name: "SetPlatformApplicationAttributesCommand",
          input: { PlatformApplicationArn: APP_ARN, Attributes: TOKEN_ATTRIBUTES },
        },
      ]);
      expect(loggedText()).toContain("Setting token credentials");
      expectNoSecretInLogs(TOKEN_SECRET);
    });

    test("Update of a resource whose creation was skipped creates the application with token credentials", async () => {
      const { handler, snsCommands } = loadHandler(secretString(JSON.stringify(TOKEN_SECRET)));

      await expect(handler({ ...updateEvent, PhysicalResourceId: "none" })).resolves.toEqual({
        PhysicalResourceId: APP_ARN,
        Data: { PlatformApplicationArn: APP_ARN },
      });
      expect(snsCommands.map(({ name, input }) => ({ name, attributes: input.Attributes }))).toEqual([
        { name: "CreatePlatformApplicationCommand", attributes: TOKEN_ATTRIBUTES },
      ]);
    });

    test("takes the PEM block out of the key file and trims the IDs", async () => {
      const secret = {
        SigningKey: `AuthKey file\n\n${SIGNING_KEY}\n\n`,
        SigningKeyId: ` ${KEY_ID}\n`,
        TeamId: `${TEAM_ID} `,
        BundleId: `\t${BUNDLE_ID}\n`,
      };
      const { handler, snsCommands } = loadHandler(secretString(JSON.stringify(secret)));

      await handler(updateEvent);

      expect(snsCommands.map(({ input }) => input.Attributes)).toEqual([TOKEN_ATTRIBUTES]);
    });

    const without = (field: keyof typeof TOKEN_SECRET) => {
      const { [field]: _omitted, ...rest } = TOKEN_SECRET;
      return rest;
    };
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey;

    test.each([
      ["no SigningKey", without("SigningKey"), "SigningKey is not"],
      ["a SigningKey that is not PEM", { ...TOKEN_SECRET, SigningKey: SENTINEL }, "SigningKey is not"],
      // KEY is a PKCS#8 PEM shape around a body that is not a key.
      [
        "a PKCS#8 PEM that does not parse",
        { ...TOKEN_SECRET, SigningKey: KEY.replace("MIIEfakekey", SENTINEL) },
        "SigningKey is not",
      ],
      ["an RSA key", { ...TOKEN_SECRET, SigningKey: pkcs8(rsa) }, "SigningKey is not"],
      ["a P-384 key", { ...TOKEN_SECRET, SigningKey: pkcs8(p384) }, "SigningKey is not"],
      [
        "a SEC1 (BEGIN EC PRIVATE KEY) key",
        { ...TOKEN_SECRET, SigningKey: p256.export({ type: "sec1", format: "pem" }).toString() },
        "SigningKey is not",
      ],
      [
        "an encrypted PKCS#8 key",
        {
          ...TOKEN_SECRET,
          SigningKey: p256
            .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: SENTINEL })
            .toString(),
        },
        "SigningKey is not",
      ],
      ["no SigningKeyId", without("SigningKeyId"), "SigningKeyId is not"],
      ["a lower-case SigningKeyId", { ...TOKEN_SECRET, SigningKeyId: KEY_ID.toLowerCase() }, "SigningKeyId is not"],
      ["a 9-character TeamId", { ...TOKEN_SECRET, TeamId: TEAM_ID.slice(0, 9) }, "TeamId is not"],
      ["a numeric TeamId", { ...TOKEN_SECRET, TeamId: 1234567890 }, "TeamId is not"],
      ["no BundleId", without("BundleId"), "BundleId is not"],
      ["a BundleId without a dot", { ...TOKEN_SECRET, BundleId: SENTINEL }, "BundleId is not"],
      [
        "token and certificate fields at once",
        { ...TOKEN_SECRET, PlatformPrincipal: CERT, PlatformCredential: KEY },
        "both token and certificate fields",
      ],
      [
        "a certificate alias next to the token fields",
        { ...TOKEN_SECRET, certificate: CERT },
        "both token and certificate fields",
      ],
    ])("a token secret with %s changes nothing and logs why, never a value", async (_label, secret, reason) => {
      const { handler, snsCommands } = loadHandler(secretString(JSON.stringify(secret)));

      await expect(handler({ RequestType: "Create", ResourceProperties: properties })).resolves.toEqual({
        PhysicalResourceId: "none",
        Data: { PlatformApplicationArn: "" },
      });
      await expect(handler(updateEvent)).resolves.toEqual({
        PhysicalResourceId: APP_ARN,
        Data: { PlatformApplicationArn: APP_ARN },
      });
      expect(snsCommands).toEqual([]);
      expect(loggedText()).toContain("not configured yet");
      expect(loggedText()).toContain(reason);
      expectNoSecretInLogs(secret);
      expect(loggedText()).not.toContain(SENTINEL);
    });

    test("names every malformed field at once", async () => {
      const { handler } = loadHandler(
        secretString(JSON.stringify({ SigningKey: SENTINEL, SigningKeyId: "", TeamId: null, BundleId: "x" })),
      );

      await handler(updateEvent);

      const logged = loggedText();
      for (const field of ["SigningKey is not", "SigningKeyId is not", "TeamId is not", "BundleId is not"]) {
        expect(logged).toContain(field);
      }
      expect(logged).not.toContain(SENTINEL);
    });

    test("SNS refusing the token credentials as invalid keeps the application and logs no message", async () => {
      const { handler, snsCommands } = loadHandler(
        secretString(JSON.stringify(TOKEN_SECRET)),
        Object.assign(new Error(`Invalid parameter: ${SENTINEL}`), { name: "InvalidParameterException" }),
      );

      await expect(handler(updateEvent)).resolves.toEqual({
        PhysicalResourceId: APP_ARN,
        Data: { PlatformApplicationArn: APP_ARN },
      });
      await expect(handler({ RequestType: "Create", ResourceProperties: properties })).resolves.toEqual({
        PhysicalResourceId: "none",
        Data: { PlatformApplicationArn: "" },
      });
      expect(snsCommands.map(({ name }) => name)).toEqual([
        "SetPlatformApplicationAttributesCommand",
        "CreatePlatformApplicationCommand",
      ]);
      expect(loggedText()).toContain("SNS refused the token credentials: InvalidParameterException");
      expect(loggedText()).not.toContain(SENTINEL);
      expectNoSecretInLogs(TOKEN_SECRET);
    });

    test("other SNS errors with token credentials still fail the deployment", async () => {
      const { handler } = loadHandler(
        secretString(JSON.stringify(TOKEN_SECRET)),
        Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
      );

      await expect(handler(updateEvent)).rejects.toThrow("throttled");
    });
  });
});
