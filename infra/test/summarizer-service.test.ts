import { Match, Template } from "aws-cdk-lib/assertions";
import { BILL_SUMMARIZER_MODEL } from "../lib/config/bedrock-models";
import { leadingKeysCondition, partitionScopedGrants, roleStatementsOf, storeActions } from "./helpers/cdk-test-helpers";
import { synthesizeStacks } from "./helpers/synth-stacks";
import {
  BILL_STORE_BUCKET_NAME,
  CONGRESS_MEMBER_STORE_BUCKET_NAME,
  DEPLOYMENT_ACCOUNT_ID,
} from "../lib/config/deployment-identity";

const templates = synthesizeStacks();

// Renders an Fn::Join of strings and { Ref } pseudo-parameters as "${Ref}" text.
const renderJoin = (value: unknown): unknown => {
  const join = (value as { "Fn::Join"?: [string, unknown[]] } | null)?.["Fn::Join"];
  if (!join) {
    return value;
  }
  const [separator, parts] = join;
  return parts
    .map((part) => (typeof part === "string" ? part : `\${${(part as { Ref: string }).Ref}}`))
    .join(separator);
};

const inferenceProfileArn = (modelId: string) =>
  `arn:\${AWS::Partition}:bedrock:\${AWS::Region}:\${AWS::AccountId}:inference-profile/us.${modelId}`;
const foundationModelArn = (modelId: string) => `arn:\${AWS::Partition}:bedrock:*::foundation-model/${modelId}`;

const bedrockStatements = (template: Template) =>
  Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  ).filter((statement) => [statement.Action].flat().some((action) => action.startsWith("bedrock:")));

describe("SummarizerServiceStack", () => {
  test("wires the summarizer lambda to the queue", () => {
    templates.summarizerTemplate.hasResourceProperties(
      "AWS::Lambda::Function",
      {
        FunctionName: "BillSummarizer",
      }
    );
    templates.summarizerTemplate.hasResourceProperties(
      "AWS::Lambda::Function",
      {
        FunctionName: "CongressMemberSummarizer",
      }
    );
    templates.summarizerTemplate.hasResourceProperties(
      "AWS::Lambda::Function",
      {
        FunctionName: "BillDiffer",
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            QUEUE_URL: Match.anyValue(),
            CONGRESS_MEMBER_STATS_QUEUE_URL: Match.absent(),
          }),
        },
      }
    );

    templates.summarizerTemplate.hasResourceProperties(
      "AWS::Lambda::EventSourceMapping",
      {
        Enabled: true,
      }
    );

    templates.summarizerTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "BillSummarizerQueue",
      VisibilityTimeout: 360,
    });
    templates.summarizerTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillSummarizer",
      Timeout: 120,
    });
  });

  // CAP-05: CreateBillsManifest forwards each processed-bill version to member stats instead. The
  // transition send grant went in switchover step U9f.
  test("BillDiffer has no member stats queue URL and no send grant to it", () => {
    const template = templates.summarizerTemplate.toJSON();
    expect(JSON.stringify(template)).not.toContain("CONGRESS_MEMBER_STATS_QUEUE_URL");
    const sendStatements = Object.values(template.Resources as Record<string, any>)
      .filter((resource) => resource.Type === "AWS::IAM::Policy")
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>)
      .filter((statement) => JSON.stringify(statement.Action).includes("sqs:SendMessage"));
    expect(sendStatements.some((statement) => JSON.stringify(statement.Resource).includes("CongressMemberStatsQueue"))).toBe(false);
  });

  test("every SQS mapping reports partial batch failures", () => {
    const mappings = templates.summarizerTemplate.findResources("AWS::Lambda::EventSourceMapping");
    expect(Object.keys(mappings)).toHaveLength(3);
    for (const [id, mapping] of Object.entries(mappings)) {
      expect({ id, types: mapping.Properties.FunctionResponseTypes }).toEqual({
        id,
        types: ["ReportBatchItemFailures"],
      });
    }
  });

  // LLM-11: one bill per call, 3 calls at once, room for thinking within max_tokens, and a per-call deadline.
  test("configures single-bill Bedrock calls", () => {
    templates.summarizerTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillSummarizer",
      Environment: {
        Variables: Match.objectLike({
          MAX_BILLS_PER_BATCH: "1",
          MAX_OUTPUT_TOKENS: "8192",
          BEDROCK_EFFORT: "medium",
          BEDROCK_CONCURRENCY: "3",
          BEDROCK_CALL_TIMEOUT_MS: "60000",
        }),
      },
    });
  });

  // LLM-11: the role may invoke every granted model, so switching MODEL_ID, or moving the alias back across
  // the switch, needs no IAM change.
  test("scopes bedrock:InvokeModel to the inference profiles and foundation models of the granted models", () => {
    const statements = bedrockStatements(templates.summarizerTemplate);
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe("bedrock:InvokeModel");
    expect([statements[0].Resource].flat().map(renderJoin)).toEqual(
      BILL_SUMMARIZER_MODEL.grantedModelIds.flatMap((modelId) => [inferenceProfileArn(modelId), foundationModelArn(modelId)]),
    );

    const summarizer = Object.values(
      templates.summarizerTemplate.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "BillSummarizer" },
      }),
    )[0];
    expect(renderJoin(summarizer.Properties.Environment.Variables.MODEL_ID)).toBe(
      inferenceProfileArn(BILL_SUMMARIZER_MODEL.modelId),
    );
    expect(JSON.stringify(templates.summarizerTemplate.toJSON())).not.toContain(DEPLOYMENT_ACCOUNT_ID);
  });

  test("keeps 90 days of logs for every summarizer function", () => {
    for (const functionName of ["BillDiffer", "BillSummarizer", "CongressMemberSummarizer"]) {
      templates.summarizerTemplate.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: `/aws/lambda/${functionName}`,
        RetentionInDays: 90,
      });
    }
  });

  test("deploys every worker all at once", () => {
    templates.summarizerTemplate.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
    const groups = templates.summarizerTemplate.findResources("AWS::CodeDeploy::DeploymentGroup");
    expect(Object.keys(groups)).toHaveLength(3);
    for (const [id, group] of Object.entries(groups)) {
      expect({ id, config: group.Properties.DeploymentConfigName }).toEqual({
        id,
        config: "CodeDeployDefault.LambdaAllAtOnce",
      });
    }
  });

  // CQ-15: CongressStoreStack's buckets, referenced by their fixed names.
  test("lets the differ and summarizer read and write the bill store, and the member summarizer the member store", () => {
    const access = (functionName: string) => storeActions(roleStatementsOf(templates.summarizerTemplate, functionName));
    const billStore = [`bucket/${BILL_STORE_BUCKET_NAME}`, `bucket/${BILL_STORE_BUCKET_NAME}/*`];
    // BillDiffer also keeps the companion link lists in BillsManifest (APPF-23, next test).
    expect(Object.keys(access("BillDiffer"))).toEqual([...billStore, "table/BillsManifest"]);
    expect(Object.keys(access("BillSummarizer"))).toEqual(billStore);
    ["BillDiffer", "BillSummarizer"].forEach((functionName) => {
      expect(access(functionName)[`bucket/${BILL_STORE_BUCKET_NAME}/*`]).toEqual(
        expect.arrayContaining(["s3:GetObject*", "s3:PutObject"]),
      );
    });
    expect(Object.keys(access("CongressMemberSummarizer"))).toEqual([
      `bucket/${CONGRESS_MEMBER_STORE_BUCKET_NAME}`,
      `bucket/${CONGRESS_MEMBER_STORE_BUCKET_NAME}/*`,
    ]);
  });

  // APPF-23: BillDiffer syncs each bill's identical-bill link list (pk=BILL_COMPANION_DECL, sk=plain
  // guid) with conditional puts and deletes, and may touch no other BillsManifest row.
  test("BillDiffer may get, put and delete only BILL_COMPANION_DECL rows in BillsManifest", () => {
    const statements = roleStatementsOf(templates.summarizerTemplate, "BillDiffer");
    expect(partitionScopedGrants(statements)).toEqual([
      {
        resource: "table/BillsManifest",
        actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem"],
        condition: leadingKeysCondition("BILL_COMPANION_DECL"),
      },
    ]);
    const manifestStatements = statements.filter((statement) => JSON.stringify(statement.Resource).includes("table/BillsManifest"));
    expect(manifestStatements).toHaveLength(1);

    templates.summarizerTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillDiffer",
      Environment: {
        Variables: Match.objectLike({
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
          MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
          GUID_LOOKUP_PK: "BILL_GUID",
          COMPANION_GROUPS_ENABLED: Match.absent(),
          TABLE_NAME: Match.absent(),
        }),
      },
    });
  });
});
