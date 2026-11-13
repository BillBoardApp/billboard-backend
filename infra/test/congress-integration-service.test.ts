import { Match } from "aws-cdk-lib/assertions";
import { isDataWrite, roleStatementsOf, storeActions } from "./helpers/cdk-test-helpers";
import { synthesizeStacks } from "./helpers/synth-stacks";
import { BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME } from "../lib/config/deployment-identity";
import {
  assertFetchRawBillRetryLadder,
  FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
  FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES,
  FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
  FETCH_RETRY_BACKOFF,
  REFETCH_UNCHANGED_MODE,
  UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
} from "../lib/config/congress-integration-service-constants";

const templates = synthesizeStacks();

const RESERVED_CONCURRENCY_VARIABLE = "BILLS_API_POLLER_RESERVED_CONCURRENCY";

// Runs `fn` with the poller's reserved-concurrency variable set to `value`
// (undefined unsets it), then restores whatever the runner had.
const withPollerReservedConcurrency = (value: string | undefined, fn: () => void): void => {
  const previous = process.env[RESERVED_CONCURRENCY_VARIABLE];
  if (value === undefined) {
    delete process.env[RESERVED_CONCURRENCY_VARIABLE];
  } else {
    process.env[RESERVED_CONCURRENCY_VARIABLE] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[RESERVED_CONCURRENCY_VARIABLE];
    } else {
      process.env[RESERVED_CONCURRENCY_VARIABLE] = previous;
    }
  }
};

// The constant is read when its module loads, so each setting needs a fresh module registry.
const pollerReservedConcurrencyFor = (value: string | undefined): number | undefined => {
  let result: number | undefined;
  withPollerReservedConcurrency(value, () => {
    jest.isolateModules(() => {
      result = require("../lib/config/congress-integration-service-constants").BILLS_API_POLLER_RESERVED_CONCURRENCY;
    });
  });
  return result;
};

describe("CongressIntegrationServiceStack", () => {
  test("provisions ingest queues with a dead-letter queue", () => {
    templates.congressTemplate.resourceCountIs("AWS::SQS::Queue", 10);
    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "UpdatedBillsQueue",
      // REL-58: 11 receives, the retry ladder's 10 steps plus the last; the base visibility stays 180 s.
      VisibilityTimeout: 180,
      RedrivePolicy: {
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 11,
      },
    });
    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "UpdatedCongressMembersQueue",
      RedrivePolicy: {
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 5,
      },
    });

    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "BillDifferQueue",
      RedrivePolicy: {
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 5,
      },
    });


    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "CongressMemberSummarizerQueue",
      RedrivePolicy: {
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 5,
      },
    });

    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "BillVoteEnrichmentQueue",
      RedrivePolicy: {
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 5,
      },
    });
  });

  test("creates polling and fetcher lambdas wired to the queue", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillsApiPoller",
      Runtime: "nodejs24.x",
    });

    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawBill",
      Runtime: "nodejs24.x",
      MemorySize: 512,
    });

    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "EnrichOfficialVotes",
      Runtime: "nodejs24.x",
      MemorySize: 512,
    });

    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchCongressMembersList",
      Runtime: "nodejs24.x",
    });

    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawCongressMembers",
      Runtime: "nodejs24.x",
    });

    templates.congressTemplate.resourceCountIs("AWS::Lambda::EventSourceMapping", 3);
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      ScalingConfig: {
        MaximumConcurrency: 2,
      },
      Enabled: true,
    });
  });

  test("every SQS mapping reports partial batch failures", () => {
    const mappings = templates.congressTemplate.findResources("AWS::Lambda::EventSourceMapping");
    expect(Object.keys(mappings)).toHaveLength(3);
    for (const [id, mapping] of Object.entries(mappings)) {
      expect({ id, types: mapping.Properties.FunctionResponseTypes }).toEqual({
        id,
        types: ["ReportBatchItemFailures"],
      });
    }
  });

  // Overlapping poller runs race the SSM cursor (REL-06), so the reservation is on unless
  // explicitly turned off.
  test("BillsApiPoller reserves one concurrent execution by default", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillsApiPoller",
      ReservedConcurrentExecutions: 1,
      Environment: {
        Variables: Match.objectLike({
          POLL_CONGRESS: "119",
          BILL_TYPES: "hr,s,hjres,sjres,hconres,sconres,hres,sres",
          MAX_PAGES_PER_BILL_TYPE: "20",
          CONGRESS_API_REQUEST_TIMEOUT_MS: "10000",
        }),
      },
    });
  });

  // REL-46: one poller for the 119th and the 120th, each Congress with its own cursor parameter. Any CloudFormation
  // update to a cursor parameter writes UNINITIALIZED over the live cursor, so the original one must not change at all.
  describe("BillsApiPoller polls the 119th and the 120th (REL-46)", () => {
    type CfnParameter = { Type: string; Properties: Record<string, unknown> };
    const parameters = (): Record<string, CfnParameter> =>
      templates.congressTemplate.findResources("AWS::SSM::Parameter") as Record<string, CfnParameter>;
    const parameter120Id = (): string => {
      const ids = Object.keys(parameters()).filter((id) => /^BillsApiPollerStateParameter120[0-9A-F]{8}$/.test(id));
      expect(ids).toHaveLength(1);
      return ids[0];
    };

    test("keeps the original cursor parameter exactly as it was", () => {
      expect(parameters().BillsApiPollerStateParameterC64331E8).toEqual({
        Type: "AWS::SSM::Parameter",
        Properties: { Name: "/billboard/congress/bills-poller-state", Type: "String", Value: "UNINITIALIZED" },
      });
    });

    test("adds the 120th's cursor parameter as UNINITIALIZED, and no other", () => {
      expect(parameters()[parameter120Id()]).toEqual({
        Type: "AWS::SSM::Parameter",
        Properties: { Name: "/billboard/congress/bills-poller-state-120", Type: "String", Value: "UNINITIALIZED" },
      });
      expect(Object.keys(parameters()).sort()).toEqual(["BillsApiPollerStateParameterC64331E8", parameter120Id()].sort());
    });

    test("names both in POLL_TARGETS and keeps POLL_CONGRESS and STATE_PARAMETER_NAME for a rollback", () => {
      templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "BillsApiPoller",
        Environment: {
          Variables: Match.objectLike({
            POLL_TARGETS: "119=/billboard/congress/bills-poller-state,120=/billboard/congress/bills-poller-state-120",
            POLL_CONGRESS: "119",
            STATE_PARAMETER_NAME: { Ref: "BillsApiPollerStateParameterC64331E8" },
          }),
        },
      });
    });

    test("lets the poller read and write both cursor parameters, and no other function either", () => {
      const cursorGrants = (functionName: string) =>
        roleStatementsOf(templates.congressTemplate, functionName)
          .filter((statement) => JSON.stringify(statement.Resource).includes("BillsApiPollerStateParameter"))
          .map((statement) => ({
            parameter: JSON.stringify(statement.Resource).match(/BillsApiPollerStateParameter[0-9A-Za-z]+/)?.[0],
            actions: [statement.Action].flat(),
          }));
      const grants = cursorGrants("BillsApiPoller");
      for (const parameter of ["BillsApiPollerStateParameterC64331E8", parameter120Id()]) {
        const actions = grants.filter((grant) => grant.parameter === parameter).flatMap((grant) => grant.actions);
        expect(actions).toEqual(expect.arrayContaining(["ssm:GetParameter", "ssm:PutParameter"]));
      }
      ["FetchRawBill", "EnrichOfficialVotes", "FetchCongressMembersList", "FetchRawCongressMembers"].forEach(
        (functionName) => expect(cursorGrants(functionName)).toEqual([]),
      );
    });
  });

  test.each([
    [undefined, 1],
    ["", 1],
    ["off", undefined],
    ["OFF", undefined],
    ["2", 2],
  ])("BILLS_API_POLLER_RESERVED_CONCURRENCY=%p resolves to %p", (value, expected) => {
    expect(pollerReservedConcurrencyFor(value)).toBe(expected);
  });

  test("BILLS_API_POLLER_RESERVED_CONCURRENCY rejects values other than off or a positive integer", () => {
    expect(() => pollerReservedConcurrencyFor("0")).toThrow(
      'BILLS_API_POLLER_RESERVED_CONCURRENCY must be "off" or an integer >= 1',
    );
  });

  test("BILLS_API_POLLER_RESERVED_CONCURRENCY=off synthesizes the poller without a reservation", () => {
    let pollerProperties: Record<string, unknown> | undefined;
    withPollerReservedConcurrency("off", () => {
      jest.isolateModules(() => {
        // Fresh copies throughout, so the stack sees the constant computed under "off".
        const cdk = require("aws-cdk-lib");
        const { Template } = require("aws-cdk-lib/assertions");
        const { SharedInfraStack } = require("../lib/stacks/shared-infra");
        const { CongressIntegrationServiceStack } = require("../lib/stacks/congress-integration-service");
        const app = new cdk.App();
        const shared = new SharedInfraStack(app, "SharedInfraStack");
        const stack = new CongressIntegrationServiceStack(app, "CongressIntegrationServiceStack", {
          lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
        });
        const functions = Template.fromStack(stack).findResources("AWS::Lambda::Function", {
          Properties: { FunctionName: "BillsApiPoller" },
        }) as Record<string, { Properties: Record<string, unknown> }>;
        pollerProperties = Object.values(functions)[0]?.Properties;
      });
    });
    expect(pollerProperties).toBeDefined();
    expect(pollerProperties).not.toHaveProperty("ReservedConcurrentExecutions");
  });

  // QUEUE_BATCH_SIZE is the poller's SendMessageBatch chunk size (SQS allows up to 10);
  // FetchRawBill still receives one message per invocation.
  test("BillsApiPoller sends bills in SendMessageBatch chunks of 10", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillsApiPoller",
      Environment: { Variables: Match.objectLike({ QUEUE_BATCH_SIZE: "10" }) },
    });
    const updatedBillsQueueId = Object.keys(
      templates.congressTemplate.findResources("AWS::SQS::Queue", {
        Properties: { QueueName: "UpdatedBillsQueue" },
      }),
    )[0];
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: { "Fn::GetAtt": [updatedBillsQueueId, "Arn"] },
      BatchSize: 1,
    });
  });

  // Only the poller reads SOFT_STOP_REMAINING_MS; FetchRawBill never did.
  test("SOFT_STOP_REMAINING_MS goes to BillsApiPoller, not FetchRawBill", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillsApiPoller",
      Environment: { Variables: Match.objectLike({ SOFT_STOP_REMAINING_MS: "3000" }) },
    });
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawBill",
      Environment: { Variables: Match.objectLike({ SOFT_STOP_REMAINING_MS: Match.absent() }) },
    });
  });

  test("all three congress.gov bill callers share the retry count and request timeout", () => {
    for (const functionName of ["BillsApiPoller", "FetchRawBill", "EnrichOfficialVotes"]) {
      templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
        Environment: {
          Variables: Match.objectLike({
            CONGRESS_API_MAX_RETRIES: "2",
            CONGRESS_API_REQUEST_TIMEOUT_MS: "10000",
          }),
        },
      });
    }
  });

  test("members fetchers get room for paced calls, the manifest check and one-at-a-time pacing", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchCongressMembersList",
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          CONGRESS_MEMBERS_MANIFEST_TABLE_NAME: "CongressMembersManifest",
          // The members fetchers keep their own 4 s default.
          CONGRESS_API_REQUEST_TIMEOUT_MS: Match.absent(),
        }),
      },
    });
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawCongressMembers",
      Timeout: 60,
    });
    templates.congressTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "UpdatedCongressMembersQueue",
      VisibilityTimeout: 360,
    });
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 5,
      ScalingConfig: { MaximumConcurrency: 2 },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  test("every congress.gov caller can read the API key and publish BillIngestion metrics", () => {
    const policies = Object.values(templates.congressTemplate.findResources("AWS::IAM::Policy"));
    const functions = templates.congressTemplate.findResources("AWS::Lambda::Function");
    [
      "BillsApiPoller",
      "FetchRawBill",
      "EnrichOfficialVotes",
      "FetchCongressMembersList",
      "FetchRawCongressMembers",
    ].forEach((functionName) => {
      const fn = Object.values(functions).find((resource) => resource.Properties.FunctionName === functionName);
      const roleLogicalId = fn?.Properties.Role["Fn::GetAtt"][0];
      const statements = policies
        .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);

      expect({ functionName, statements }).toEqual({
        functionName,
        statements: expect.arrayContaining([
          expect.objectContaining({
            Action: "cloudwatch:PutMetricData",
            Condition: { StringEquals: { "cloudwatch:namespace": "BillBoard/BillIngestion" } },
          }),
          expect.objectContaining({
            Action: expect.arrayContaining(["secretsmanager:GetSecretValue"]),
          }),
        ]),
      });
    });
  });

  test("congress.gov callers get a request timeout and unchanged tuning values", () => {
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawBill",
      Environment: {
        Variables: Match.objectLike({
          CONGRESS_API_REQUEST_TIMEOUT_MS: "10000",
          CONGRESS_API_CALL_DELAY_MS: "1200",
          CONGRESS_API_MAX_CALLS_PER_BILL: "10",
          CONGRESS_API_MAX_RETRIES: "2",
        }),
      },
    });
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "EnrichOfficialVotes",
      Environment: {
        Variables: Match.objectLike({
          CONGRESS_API_REQUEST_TIMEOUT_MS: "10000",
          CONGRESS_API_MAX_RETRIES: "2",
          CONGRESS_VOTE_CALL_DELAY_MS: "1500",
          CONGRESS_API_MAX_HOUSE_VOTE_PAGES: "2",
          CONGRESS_VOTE_MAX_CALLS_PER_BILL: "4",
          VOTE_ENRICHMENT_DEFER_DELAY_SECONDS: "900",
          VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS: "4",
        }),
      },
    });
  });

  // REL-45: bill text from GovInfo first, reuse of the stored text of the same version, and the delayed retry of a
  // refused text back onto UpdatedBillsQueue.
  test("FetchRawBill gets the bill text settings and may send its delayed retry to UpdatedBillsQueue", () => {
    const queues = templates.congressTemplate.findResources("AWS::SQS::Queue", {
      Properties: { QueueName: "UpdatedBillsQueue" },
    });
    const [updatedBillsQueueId] = Object.keys(queues);
    expect(updatedBillsQueueId).toBeDefined();

    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawBill",
      Environment: {
        Variables: Match.objectLike({
          BILL_XML_SOURCES: "govinfo,congress",
          BILL_XML_REUSE_SAME_VERSION: "on",
          TEXT_RETRY_QUEUE_URL: { Ref: updatedBillsQueueId },
          BILL_TEXT_RETRY_DELAY_SECONDS: "600",
          BILL_TEXT_MAX_RETRIES: "3",
          BILL_XML_FETCH_BUDGET_MS: "40000",
          BILL_XML_REFUSED_HOST_COOLDOWN_MS: "600000",
        }),
      },
    });

    const sendsToUpdatedBills = roleStatementsOf(templates.congressTemplate, "FetchRawBill")
      .filter((statement) => JSON.stringify(statement.Resource).includes(updatedBillsQueueId))
      .flatMap((statement) => [statement.Action].flat());
    expect(sendsToUpdatedBills).toEqual(expect.arrayContaining(["sqs:ReceiveMessage", "sqs:SendMessage"]));
    // Only FetchRawBill: no other function here gained the setting.
    const holders = Object.values(templates.congressTemplate.findResources("AWS::Lambda::Function"))
      .filter((fn) => "TEXT_RETRY_QUEUE_URL" in (fn.Properties.Environment?.Variables ?? {}))
      .map((fn) => fn.Properties.FunctionName);
    expect(holders).toEqual(["FetchRawBill"]);
  });

  // REL-57: a poller refetch equal to the stored copy is not stored again under "on". It ships as "watch" (logs and
  // counts only); the comparison uses the stored copy REL-35 already reads, so no grant changes.
  test("FetchRawBill gets REFETCH_UNCHANGED_MODE from its constant (watch), and only FetchRawBill", () => {
    expect(REFETCH_UNCHANGED_MODE).toBe("watch");
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "FetchRawBill",
      Environment: { Variables: Match.objectLike({ REFETCH_UNCHANGED_MODE: "watch", MEMBER_VOTE_CARRY_MODE: "on" }) },
    });
    const holders = Object.values(templates.congressTemplate.findResources("AWS::Lambda::Function"))
      .filter((fn) => "REFETCH_UNCHANGED_MODE" in (fn.Properties.Environment?.Variables ?? {}))
      .map((fn) => fn.Properties.FunctionName);
    expect(holders).toEqual(["FetchRawBill"]);
  });

  // REL-58: FetchRawBill sets a failed record's visibility from a ladder of about 6 hours for congress.gov failures
  // (60 s for anything else, bulk messages and the final receive), so the queue keeps a message 11 receives.
  describe("FetchRawBill's retry ladder (REL-58)", () => {
    test("ships on, with a ladder of about 6 hours whose length plus the last receive is the queue's maxReceiveCount", () => {
      expect(FETCH_RETRY_BACKOFF).toBe("on");
      expect(FETCH_RAW_BILL_RETRY_LADDER_SECONDS).toEqual([180, 300, 600, 1200, 1800, 3600, 3600, 3600, 3600, 3600]);
      expect(UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT).toBe(FETCH_RAW_BILL_RETRY_LADDER_SECONDS.length + 1);
      expect(FETCH_RAW_BILL_RETRY_LADDER_SECONDS.reduce((sum, step) => sum + step, 0)).toBeGreaterThanOrEqual(6 * 3600);
      expect(FETCH_RAW_BILL_RETRY_OTHER_SECONDS).toBe(60);
      // A bill-endpoint 404 takes the first 4 steps (38 minutes), then counts as any other failure.
      expect(FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES).toBe(4);
      expect(FETCH_RAW_BILL_RETRY_LADDER_SECONDS.slice(0, 4).reduce((sum, step) => sum + step, 0)).toBe(38 * 60);
    });

    test("FetchRawBill gets the switch and the ladder, and only FetchRawBill", () => {
      templates.congressTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "FetchRawBill",
        Environment: {
          Variables: Match.objectLike({
            FETCH_RETRY_BACKOFF: "on",
            FETCH_RETRY_LADDER_SECONDS: "180,300,600,1200,1800,3600,3600,3600,3600,3600",
            FETCH_RETRY_OTHER_SECONDS: "60",
            FETCH_RETRY_NOT_FOUND_RECEIVES: "4",
            FETCH_RETRY_MAX_RECEIVES: "11",
          }),
        },
      });
      const holders = Object.values(templates.congressTemplate.findResources("AWS::Lambda::Function"))
        .filter((fn) => "FETCH_RETRY_BACKOFF" in (fn.Properties.Environment?.Variables ?? {}))
        .map((fn) => fn.Properties.FunctionName);
      expect(holders).toEqual(["FetchRawBill"]);
    });

    test("FetchRawBill may change the visibility of UpdatedBillsQueue's messages (its consume grant)", () => {
      const [updatedBillsQueueId] = Object.keys(
        templates.congressTemplate.findResources("AWS::SQS::Queue", { Properties: { QueueName: "UpdatedBillsQueue" } }),
      );
      const actions = roleStatementsOf(templates.congressTemplate, "FetchRawBill")
        .filter((statement) => JSON.stringify(statement.Resource).includes(updatedBillsQueueId))
        .flatMap((statement) => [statement.Action].flat());
      expect(actions).toContain("sqs:ChangeMessageVisibility");
    });

    test.each<[string, Parameters<typeof assertFetchRawBillRetryLadder>[0], RegExp]>([
      [
        "a step under a minute",
        { backoff: "on", steps: [30, 300], maxReceiveCount: 3, otherSeconds: 60, notFoundReceives: 1 },
        /from 60 to 43200/,
      ],
      [
        "a step over 12 hours",
        { backoff: "on", steps: [180, 43_201], maxReceiveCount: 3, otherSeconds: 60, notFoundReceives: 1 },
        /from 60 to 43200/,
      ],
      [
        "a ladder that does not fit the receives",
        { backoff: "on", steps: [180, 300], maxReceiveCount: 11, otherSeconds: 60, notFoundReceives: 1 },
        /plus 1 must equal/,
      ],
      [
        "a ladder shorter than 6 hours",
        { backoff: "on", steps: [180, 300, 600], maxReceiveCount: 4, otherSeconds: 60, notFoundReceives: 1 },
        /at least 21600/,
      ],
      [
        "other seconds over 15 minutes",
        { backoff: "on", steps: Array(7).fill(3600), maxReceiveCount: 8, otherSeconds: 901, notFoundReceives: 1 },
        /FETCH_RAW_BILL_RETRY_OTHER_SECONDS/,
      ],
      [
        "a 404 on every receive",
        { backoff: "on", steps: Array(7).fill(3600), maxReceiveCount: 8, otherSeconds: 60, notFoundReceives: 8 },
        /FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES/,
      ],
    ])("the synth-time check refuses %s", (_name, ladder, message) => {
      expect(() => assertFetchRawBillRetryLadder(ladder)).toThrow(message);
    });

    // The rollback's second step: with the switch off, the receive count goes back to 3 under the same ladder.
    test("the synth-time check leaves the receive count free while the switch is off", () => {
      expect(() =>
        assertFetchRawBillRetryLadder({
          backoff: "off",
          steps: FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
          maxReceiveCount: 3,
          otherSeconds: FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
          notFoundReceives: FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES,
        }),
      ).not.toThrow();
    });

    test("the synth-time check passes the shipped ladder", () => {
      expect(() =>
        assertFetchRawBillRetryLadder({
          backoff: FETCH_RETRY_BACKOFF,
          steps: FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
          maxReceiveCount: UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
          otherSeconds: FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
          notFoundReceives: FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES,
        }),
      ).not.toThrow();
    });
  });

  test("keeps 90 days of logs for every ingestion function", () => {
    for (const functionName of [
      "BillsApiPoller",
      "FetchRawBill",
      "EnrichOfficialVotes",
      "FetchCongressMembersList",
      "FetchRawCongressMembers",
    ]) {
      templates.congressTemplate.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: `/aws/lambda/${functionName}`,
        RetentionInDays: 90,
      });
    }
  });

  test("deploys every worker all at once", () => {
    templates.congressTemplate.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
    const groups = templates.congressTemplate.findResources("AWS::CodeDeploy::DeploymentGroup");
    expect(Object.keys(groups)).toHaveLength(5);
    for (const [id, group] of Object.entries(groups)) {
      expect({ id, config: group.Properties.DeploymentConfigName }).toEqual({
        id,
        config: "CodeDeployDefault.LambdaAllAtOnce",
      });
    }
  });

  // C1.1: all three rules send what they cannot deliver to ScheduledJobFailures (under SharedInfraStack's queue
  // policy). FetchCongressMembersList is weekly (daily Jan 2-17, 2027), so its failed run is recorded there too, after Lambda's
  // default 2 retries; the poller's next run (5 minutes) is its rerun.
  test("all three schedules dead-letter to ScheduledJobFailures and the members job records failures", () => {
    const queueArn = Match.objectLike({ "Fn::Join": ["", Match.arrayWith([":ScheduledJobFailures"])] });
    const rules = Object.values(templates.congressTemplate.findResources("AWS::Events::Rule"));
    expect(rules).toHaveLength(3);
    rules.forEach((rule) => {
      expect(rule.Properties.Targets).toHaveLength(1);
      expect(rule.Properties.Targets[0].RetryPolicy).toBeUndefined();
    });
    templates.congressTemplate.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
      Targets: [Match.objectLike({ DeadLetterConfig: { Arn: queueArn } })],
    });
    templates.congressTemplate.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(7 days)",
      Targets: [Match.objectLike({ DeadLetterConfig: { Arn: queueArn } })],
    });

    // REL-46: the daily window from 2027-01-02 to 2027-01-17 (17:00 EST), then it stops by itself.
    templates.congressTemplate.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 22 2-17 1 ? 2027)",
      Targets: [Match.objectLike({ DeadLetterConfig: { Arn: queueArn } })],
    });

    const invokeConfigs = Object.values(templates.congressTemplate.findResources("AWS::Lambda::EventInvokeConfig"));
    expect(invokeConfigs).toHaveLength(1);
    templates.congressTemplate.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: Match.stringLikeRegexp("^FetchCongressMembersList") },
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: queueArn } },
    });
    const sqsActions = roleStatementsOf(templates.congressTemplate, "FetchCongressMembersList")
      .filter((statement) => JSON.stringify(statement.Resource).includes("ScheduledJobFailures"))
      .flatMap((statement) => [statement.Action].flat());
    expect(sqsActions).toEqual(["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]);
    // No other function here may send to it.
    ["BillsApiPoller", "FetchRawBill", "EnrichOfficialVotes", "FetchRawCongressMembers"].forEach((functionName) =>
      expect(JSON.stringify(roleStatementsOf(templates.congressTemplate, functionName))).not.toContain("ScheduledJobFailures"),
    );
  });

  // REL-46: the changeover rule calls the same prod alias, with the same input, as the weekly rule.
  test("the changeover rule targets what the weekly rule targets", () => {
    const rules = Object.entries(templates.congressTemplate.findResources("AWS::Events::Rule"));
    const find = (expression: string) => rules.find(([, rule]) => rule.Properties.ScheduleExpression === expression)?.[1];
    const weekly = find("rate(7 days)");
    const changeover = find("cron(0 22 2-17 1 ? 2027)");
    expect(weekly).toBeDefined();
    expect(changeover).toBeDefined();
    expect(JSON.stringify(changeover?.Properties.Targets[0].Arn)).toMatch(/FetchCongressMembersList.*ProdAlias/);
    const { Id: _weeklyId, ...weeklyTarget } = weekly?.Properties.Targets[0];
    const { Id: _changeoverId, ...changeoverTarget } = changeover?.Properties.Targets[0];
    expect(changeoverTarget).toEqual(weeklyTarget);
    expect(changeover?.Properties.State).toBe("ENABLED");
  });

  // CQ-15: CongressStoreStack's buckets and tables, referenced by their fixed names.
  test("grants each ingest function its store access by fixed name", () => {
    const access = (functionName: string) => storeActions(roleStatementsOf(templates.congressTemplate, functionName));
    const billStore = [`bucket/${BILL_STORE_BUCKET_NAME}`, `bucket/${BILL_STORE_BUCKET_NAME}/*`];

    expect(Object.keys(access("FetchRawBill"))).toEqual(billStore);
    expect(Object.keys(access("EnrichOfficialVotes"))).toEqual([...billStore, "table/CongressMembersManifest"]);
    ["FetchRawBill", "EnrichOfficialVotes"].forEach((functionName) => {
      expect(access(functionName)[`bucket/${BILL_STORE_BUCKET_NAME}/*`]).toEqual(
        expect.arrayContaining(["s3:GetObject*", "s3:PutObject"]),
      );
    });
    expect(Object.keys(access("FetchRawCongressMembers"))).toEqual([
      `bucket/${CONGRESS_MEMBER_STORE_BUCKET_NAME}`,
      `bucket/${CONGRESS_MEMBER_STORE_BUCKET_NAME}/*`,
    ]);
    // Scans the members manifest for departed members and writes nothing to it.
    expect(access("FetchCongressMembersList")).toEqual({
      "table/CongressMembersManifest": expect.arrayContaining(["dynamodb:Scan", "dynamodb:GetItem"]),
    });
    expect(access("FetchCongressMembersList")["table/CongressMembersManifest"].filter(isDataWrite)).toEqual([]);
    expect(access("EnrichOfficialVotes")["table/CongressMembersManifest"].filter(isDataWrite)).toEqual([]);
    expect(access("BillsApiPoller")).toEqual({});
  });
});
