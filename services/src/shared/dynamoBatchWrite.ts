import { BatchWriteItemCommand, type BatchWriteItemCommandOutput, type WriteRequest } from "@aws-sdk/client-dynamodb";
import { sleep } from "./retry";

type DynamoBatchWriter = {
  send(command: BatchWriteItemCommand): Promise<BatchWriteItemCommandOutput>;
};

export async function batchWriteAll(params: {
  db: DynamoBatchWriter;
  tableName: string;
  requests: WriteRequest[];
  maxBatchSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
}) {
  const { db, tableName, requests, maxBatchSize = 25, maxAttempts = 5, backoffMs = 200 } = params;

  for (let start = 0; start < requests.length; start += maxBatchSize) {
    let pending = requests.slice(start, start + maxBatchSize);

    for (let attempt = 1; pending.length > 0; attempt += 1) {
      const response = await db.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: pending,
          },
        }),
      );

      pending = response.UnprocessedItems?.[tableName] ?? [];
      if (pending.length === 0) {
        break;
      }

      if (attempt >= maxAttempts) {
        throw new Error(`Failed to process all batch write items for ${tableName}`);
      }

      await sleep(backoffMs * attempt);
    }
  }
}
