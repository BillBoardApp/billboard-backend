import type {
  AttributeValue,
  DeleteItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";

import { evaluateCondition } from "./dynamoCondition";

/**
 * An in-memory DynamoDB table with partition key `pk` (SignUpEmailClaims), reached through a mocked
 * DynamoDBClient's send. It honours the exact condition expressions callers send (fixtures/dynamoCondition), so
 * PreSignUpCheck's claim transaction, the account deletion's conditional deletes and the filter check's guarded
 * deletes are all checked against DynamoDB's semantics.
 *
 * `fault` runs before each command and may throw (a throttled or failing call) or return true to drop the
 * write silently (it is then answered as if it succeeded).
 */
export type Item = Record<string, AttributeValue>;
/** The input of any command the fake table answers, in DynamoDB's own field names. */
export type TableInput = Partial<
  GetItemCommandInput & PutItemCommandInput & DeleteItemCommandInput & TransactWriteItemsCommandInput
>;
export type TableCall = { name: string; input: TableInput };

const awsError = (name: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`${name} from the fake table`), { name, ...extra });

export class FakeClaimsTable {
  readonly items = new Map<string, Item>();
  readonly calls: TableCall[] = [];
  fault: ((call: TableCall) => boolean | void) | undefined;

  constructor(readonly tableName = "SignUpEmailClaims") {}

  get(pk: string): Item | undefined {
    return this.items.get(pk);
  }

  put(item: Item): void {
    this.items.set(item.pk.S!, item);
  }

  keys(): string[] {
    return [...this.items.keys()].sort();
  }

  send = async (
    command: { constructor: { name: string }; input: TableInput },
    _options?: unknown,
  ): Promise<unknown> => {
    const call: TableCall = { name: command.constructor.name, input: command.input };
    this.calls.push(call);
    const tableName = call.input?.TableName ?? call.input?.TransactItems?.[0]?.Put?.TableName;
    if (tableName !== undefined && tableName !== this.tableName) {
      throw new Error(`Unexpected table ${tableName}`);
    }
    if (this.fault?.(call) === true) return {};
    switch (call.name) {
      case "GetItemCommand":
        return { Item: this.items.get(call.input.Key!.pk.S!) };
      case "PutItemCommand": {
        if (!evaluateCondition(this.items.get(call.input.Item!.pk.S!), call.input)) {
          throw awsError("ConditionalCheckFailedException");
        }
        this.items.set(call.input.Item!.pk.S!, call.input.Item!);
        return {};
      }
      case "DeleteItemCommand": {
        const old = this.items.get(call.input.Key!.pk.S!);
        if (!evaluateCondition(old, call.input)) {
          throw awsError("ConditionalCheckFailedException");
        }
        this.items.delete(call.input.Key!.pk.S!);
        return call.input.ReturnValues === "ALL_OLD" && old ? { Attributes: old } : {};
      }
      case "TransactWriteItemsCommand": {
        const puts = (call.input.TransactItems ?? []).map(({ Put }) => Put!);
        const reasons = puts.map((put) => ({
          Code: evaluateCondition(this.items.get(put.Item!.pk.S!), put) ? "None" : "ConditionalCheckFailed",
        }));
        if (reasons.some((reason: { Code: string }) => reason.Code !== "None")) {
          throw awsError("TransactionCanceledException", { CancellationReasons: reasons });
        }
        for (const put of puts) this.items.set(put.Item!.pk.S!, put.Item!);
        return {};
      }
      default:
        throw new Error(`Unexpected DynamoDB command ${call.name}`);
    }
  };

  callsNamed(name: string): TableCall[] {
    return this.calls.filter((call) => call.name === name);
  }
}

export const tableError = awsError;
