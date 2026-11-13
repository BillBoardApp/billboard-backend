import type { APIGatewayProxyEvent, SQSEvent } from "aws-lambda";

/** A partial API Gateway (REST proxy) event typed as the full event; handlers read only the fields a test sets. */
export const asApiGatewayEvent = (fields: Record<string, unknown> = {}): APIGatewayProxyEvent =>
  fields as unknown as APIGatewayProxyEvent;

/** A partial SQS event typed as the full event; handlers read only the fields a test sets. */
export const asSqsEvent = (event: { Records: object[] }): SQSEvent => event as unknown as SQSEvent;

export const s3RecordsForKeys = (keys: string[], options?: { versionId?: string }) => ({
  Records: keys.map((key) => ({
    s3: {
      object: { key, ...(options?.versionId ? { versionId: options.versionId } : {}) },
    },
  })),
});

export const sqsWrappedS3Keys = (keys: string[], options?: { versionId?: string }) =>
  asSqsEvent({
    Records: keys.map((key) => ({
      body: JSON.stringify(s3RecordsForKeys([key], options)),
    })),
  });

export const sqsGuidRecords = (guids: string[]) =>
  asSqsEvent({
    Records: guids.map((guid) => ({
      body: JSON.stringify({ guid }),
    })),
  });
