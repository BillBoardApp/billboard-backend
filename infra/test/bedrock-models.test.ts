import * as cdk from "aws-cdk-lib";
import {
  BEDROCK_GRANTED_MODEL_IDS,
  BEDROCK_INFERENCE_PROFILE_GEO,
  BILL_PRIORITY_MODEL,
  BILL_SUMMARIZER_MODEL,
  BedrockCallerModel,
  CLAUDE_HAIKU_4_5,
  CLAUDE_HAIKU_5_5,
} from "../lib/config/bedrock-models";
import { bedrockInvokeModelStatement } from "../lib/stacks/helpers/bedrock-grants";

const CALLERS: Array<[string, BedrockCallerModel]> = [
  ["BillSummarizer", BILL_SUMMARIZER_MODEL],
  ["BillPriorityResolver", BILL_PRIORITY_MODEL],
];

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

describe("Bedrock models (LLM-11)", () => {
  test("names Haiku 4.5 and Haiku 5.5 by their Bedrock model IDs, through the US inference profiles", () => {
    expect(CLAUDE_HAIKU_4_5).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(CLAUDE_HAIKU_5_5).toBe("anthropic.claude-haiku-5-5");
    expect(BEDROCK_INFERENCE_PROFILE_GEO).toBe("us");
  });

  test.each(CALLERS)("%s may invoke the model it is configured with", (_caller, model) => {
    expect(model.grantedModelIds).toContain(model.modelId);
  });

  // services/src/shared/bedrockMessages.ts picks the request shape from the model ID and fails at cold start
  // on a model it has no profile for.
  test.each(CALLERS)("%s names only models the services have a request profile for", (_caller, model) => {
    [model.modelId, ...model.grantedModelIds].forEach((modelId) =>
      expect(modelId).toMatch(/claude-haiku-4-5|claude-haiku-5-5/));
  });

  // The services read BEDROCK_EFFORT at cold start and reject anything else.
  test.each(CALLERS)("%s has an effort the services accept", (_caller, model) => {
    expect(["low", "medium", "high", "default"]).toContain(model.effort);
  });

  // Until Deploy C, the model switch and an alias moved back across it need no IAM change.
  test.each(CALLERS)("%s may invoke both Haiku 4.5 and Haiku 5.5", (_caller, model) => {
    expect([...model.grantedModelIds].sort()).toEqual([CLAUDE_HAIKU_4_5, CLAUDE_HAIKU_5_5].sort());
  });

  test("the granted models are both callers' grants, each once", () => {
    const grants = CALLERS.flatMap(([, model]) => model.grantedModelIds);
    expect([...BEDROCK_GRANTED_MODEL_IDS].sort()).toEqual([...new Set(grants)].sort());
    expect(new Set(BEDROCK_GRANTED_MODEL_IDS).size).toBe(BEDROCK_GRANTED_MODEL_IDS.length);
  });

  describe("bedrockInvokeModelStatement", () => {
    const newStack = () => new cdk.Stack(new cdk.App(), "BedrockGrantsTest");
    const statementJson = (stack: cdk.Stack, model: BedrockCallerModel) =>
      stack.resolve(bedrockInvokeModelStatement(stack, model).toStatementJson());

    test("allows InvokeModel on the inference profile and foundation model of every granted model, and nothing else", () => {
      const stack = newStack();
      const statement = statementJson(stack, {
        modelId: CLAUDE_HAIKU_4_5,
        effort: "medium",
        grantedModelIds: [CLAUDE_HAIKU_5_5, CLAUDE_HAIKU_4_5],
      });
      expect(Object.keys(statement).sort()).toEqual(["Action", "Effect", "Resource"]);
      expect(statement.Effect).toBe("Allow");
      expect(statement.Action).toBe("bedrock:InvokeModel");
      expect(statement.Resource.map(renderJoin)).toEqual([
        "arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/us.anthropic.claude-haiku-5-5",
        "arn:${AWS::Partition}:bedrock:*::foundation-model/anthropic.claude-haiku-5-5",
        "arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:${AWS::Partition}:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      ]);
    });

    test("fails synth when the caller's own model is not granted", () => {
      expect(() =>
        bedrockInvokeModelStatement(newStack(), {
          modelId: CLAUDE_HAIKU_5_5,
          effort: "medium",
          grantedModelIds: [CLAUDE_HAIKU_4_5],
        }),
      ).toThrow(`Bedrock model ${CLAUDE_HAIKU_5_5} is not in its grantedModelIds (${CLAUDE_HAIKU_4_5})`);
    });

    // Deploy B changes only modelId, so the roles' policies stay exactly as Deploy A left them.
    test.each(CALLERS)("switching %s between its granted models leaves its grant unchanged", (_caller, model) => {
      const stack = newStack();
      const statements = model.grantedModelIds.map((modelId) => statementJson(stack, { ...model, modelId }));
      statements.forEach((statement) => expect(statement).toEqual(statements[0]));
    });
  });
});
