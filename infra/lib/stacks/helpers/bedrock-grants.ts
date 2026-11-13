import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BEDROCK_INFERENCE_PROFILE_GEO, BedrockCallerModel } from '../../config/bedrock-models';

/** The model's cross-region inference profile in the calling stack's account and region: what MODEL_ID holds. */
export const inferenceProfileArn = (scope: Construct, modelId: string): string =>
  cdk.Stack.of(scope).formatArn({
    service: 'bedrock',
    resource: 'inference-profile',
    resourceName: `${BEDROCK_INFERENCE_PROFILE_GEO}.${modelId}`,
  });

/**
 * The foundation model in any region. The cross-region inference profile routes to the model in several US
 * regions, so the model grant needs a region wildcard (and foundation models have no account).
 */
export const foundationModelArn = (scope: Construct, modelId: string): string =>
  cdk.Stack.of(scope).formatArn({
    service: 'bedrock',
    region: '*',
    account: '',
    resource: 'foundation-model',
    resourceName: modelId,
  });

/**
 * bedrock:InvokeModel on the inference profile and the foundation model of every model the caller may invoke,
 * and nothing else. Fails synth when the caller's own model is not among them: that function would deploy and
 * then get AccessDenied on every call.
 */
export const bedrockInvokeModelStatement = (scope: Construct, model: BedrockCallerModel): iam.PolicyStatement => {
  if (!model.grantedModelIds.includes(model.modelId)) {
    throw new Error(
      `Bedrock model ${model.modelId} is not in its grantedModelIds (${model.grantedModelIds.join(', ')}); grant it in infra/lib/config/bedrock-models.ts.`,
    );
  }
  return new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: model.grantedModelIds.flatMap((modelId) => [
      inferenceProfileArn(scope, modelId),
      foundationModelArn(scope, modelId),
    ]),
  });
};
