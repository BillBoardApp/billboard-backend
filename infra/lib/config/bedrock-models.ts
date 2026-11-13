// LLM-11: the Claude model each Bedrock caller invokes, and the models its role may invoke. Both callers
// invoke the model through its US cross-region inference profile, by ARN (MODEL_ID).
//
// The switch is a config change here in three deploys. Deploy B points modelId at CLAUDE_HAIKU_5_5; IAM does not
// change, because both models are already granted, so no window opens between the stack deploy and the alias
// shift where a function calls a model its role may not invoke. Deploy C, at least 14 days later, removes
// CLAUDE_HAIKU_4_5 from grantedModelIds; until then a prod alias can move back to a version that calls it
// (RUNBOOK 2.4).

export const CLAUDE_HAIKU_4_5 = 'anthropic.claude-haiku-4-5-20251001-v1:0';
export const CLAUDE_HAIKU_5_5 = 'anthropic.claude-haiku-5-5';

/**
 * US regions only, so requests and data stay in the US. The `us.` profile has its own tokens-per-minute quota
 * per model (Haiku 5.5: L-47520EB7); `global.` would need a second one.
 */
export const BEDROCK_INFERENCE_PROFILE_GEO = 'us';

/**
 * output_config.effort on Haiku 5.5. 'default' sends no output_config (the model default, medium): the
 * config-only fallback if Bedrock rejects the field. The services never send effort to Haiku 4.5, which
 * rejects it.
 */
export type BedrockEffort = 'low' | 'medium' | 'high' | 'default';

export interface BedrockCallerModel {
  /** The model the caller invokes. The services pick the request shape from it and fail at cold start on an unknown one. */
  readonly modelId: string;
  /** BEDROCK_EFFORT. Used only by the Haiku 5.5 request profile. */
  readonly effort: BedrockEffort;
  /** Every model the caller's role may invoke. Must include modelId: the grant helper fails synth otherwise. */
  readonly grantedModelIds: readonly string[];
}

export const BILL_SUMMARIZER_MODEL: BedrockCallerModel = {
  modelId: CLAUDE_HAIKU_4_5,
  effort: 'medium',
  grantedModelIds: [CLAUDE_HAIKU_5_5, CLAUDE_HAIKU_4_5],
};

// Low effort: picking bills that match the headlines is a bounded classification, which Haiku 4.5 ran without
// thinking. Each caller has its own constant, so one can switch model without the other.
export const BILL_PRIORITY_MODEL: BedrockCallerModel = {
  modelId: CLAUDE_HAIKU_4_5,
  effort: 'low',
  grantedModelIds: [CLAUDE_HAIKU_5_5, CLAUDE_HAIKU_4_5],
};

/** Every model either caller may invoke: the ModelId series Billboard-Bedrock-InvocationThrottles watches. */
export const BEDROCK_GRANTED_MODEL_IDS: readonly string[] = [
  ...new Set([...BILL_SUMMARIZER_MODEL.grantedModelIds, ...BILL_PRIORITY_MODEL.grantedModelIds]),
];
