import type { AttributeValue, DynamoDBClient, TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import {
  writePendingNotification,
  type PendingNotificationItem,
  type PendingNotificationStoreConfig,
} from "../shared/pendingNotifications";

/**
 * A user's pending row is keyed by bill and push type, and a later write replaces it with no condition, so a push names
 * the newest action (18.1). A change sent again by hand or redriven for an older version is written last too: its row
 * takes the place of a newer push still held for the quiet hours or the pace, and the newer change's dedupe marker
 * keeps that push from being written again. RUNBOOK 18.10 ("Send a lost change again") and 11.1 therefore count the
 * bill's pending rows (`begins_with(guid, "<bill>#")`) before a send or redrive. If the pending row ever gets a
 * condition, this file fails: revisit that check then.
 */

type Item = Record<string, AttributeValue>;

const store: PendingNotificationStoreConfig = {
  tableName: "PendingNotificationsTable",
  partitionKey: "userId",
  sortKey: "guid",
  dispatchPartitionKey: "userId",
  dispatchSortKey: "guid",
  dispatchPartitionValue: "__dispatch__",
  dispatchShardCount: 8,
  dedupePartitionValue: "__dedupe__",
};

const DEDUPE_CONDITION = "attribute_not_exists(#pk) AND attribute_not_exists(#sk)";

/** One table that applies a transaction as DynamoDB does: all puts or none, for the conditions writes use here. */
const fakeTable = () => {
  const rows = new Map<string, Item>();
  const keyOf = (item: Item) => `${item.userId.S}|${item.guid.S}`;
  const dynamo = {
    send: jest.fn(async (command: { input: TransactWriteItemsCommandInput }) => {
      const puts = command.input.TransactItems!.map((entry) => entry.Put!);
      const codes = puts.map((put) => {
        if (put.ConditionExpression === undefined) return "None";
        if (put.ConditionExpression !== DEDUPE_CONDITION) {
          throw new Error(`fake table: unsupported condition ${put.ConditionExpression}`);
        }
        return rows.has(keyOf(put.Item!)) ? "ConditionalCheckFailed" : "None";
      });
      if (codes.includes("ConditionalCheckFailed")) {
        throw Object.assign(new Error("Transaction cancelled [ConditionalCheckFailed]"), {
          name: "TransactionCanceledException",
          CancellationReasons: codes.map((Code) => ({ Code })),
        });
      }
      for (const put of puts) rows.set(keyOf(put.Item!), put.Item!);
      return {};
    }),
  };
  return { rows, dynamo: dynamo as Pick<DynamoDBClient, "send"> };
};

const USER = "user-1";

const alert = (billId: string, sourceRevision: string, text: string, actionDate: string): PendingNotificationItem => ({
  userId: USER,
  billId,
  billTitle: "A bill",
  category: "Bill Alert",
  lifeArea: "Money",
  notificationType: "alert",
  sourceRevision,
  action: { text, actionDate },
});

const pendingRow = (rows: Map<string, Item>, billId: string, type: string) => rows.get(`${USER}|${billId}#${type}`);

describe("a pending row is replaced by any later write of its bill and type (RUNBOOK 18.10, 11.1)", () => {
  it("lets an older change sent again take the place of a newer push still held, which then cannot be written again", async () => {
    const { rows, dynamo } = fakeTable();
    const billId = "BILLS-119hr2347";
    const newer = alert(billId, "version-newer", "Cloture motion on the bill presented in Senate.", "2026-11-11");
    const older = alert(billId, "version-older", "Motion to commit the bill (SA 6888) made in Senate.", "2026-11-10");

    await expect(writePendingNotification(dynamo, store, newer)).resolves.toBe("written");
    await expect(writePendingNotification(dynamo, store, older)).resolves.toBe("written");
    // A redelivery of the newer change finds its dedupe marker and writes nothing.
    await expect(writePendingNotification(dynamo, store, newer)).resolves.toBe("duplicate");

    expect(pendingRow(rows, billId, "alert")).toMatchObject({
      actionText: { S: "Motion to commit the bill (SA 6888) made in Senate." },
      actionDate: { S: "2026-11-10" },
    });
  });

  it("lets a passed with its paired action replace a held alert of the bill the same way", async () => {
    const { rows, dynamo } = fakeTable();
    const billId = "BILLS-119hres1650";
    await writePendingNotification(
      dynamo,
      store,
      alert(billId, "version-newer", "Received in the Senate.", "2026-11-13"),
    );

    await expect(
      writePendingNotification(dynamo, store, {
        ...alert(billId, "version-older", "On agreeing to the resolution Agreed to by recorded vote.", "2026-11-12"),
        notificationType: "passed",
        pairedAlert: {
          category: "Bill Alert",
          action: {
            text: "Motion to reconsider laid on the table Agreed to without objection.",
            actionDate: "2026-11-12",
          },
        },
      }),
    ).resolves.toBe("written");

    expect(pendingRow(rows, billId, "alert")).toMatchObject({
      actionText: { S: "Motion to reconsider laid on the table Agreed to without objection." },
      pairedOutcome: { S: "passed" },
    });
    expect(pendingRow(rows, billId, "passed")).toBeDefined();
  });

  it("gives the check's prefix the bill's pending rows only, no dedupe or dispatch marker", async () => {
    const { rows, dynamo } = fakeTable();
    const billId = "BILLS-119hr2347";
    await writePendingNotification(dynamo, store, alert(billId, "version-a", "Motion to commit.", "2026-11-10"));
    await writePendingNotification(dynamo, store, {
      ...alert(billId, "version-b", "Passed Senate.", "2026-11-12"),
      notificationType: "passed",
    });
    await writePendingNotification(dynamo, store, alert("BILLS-119hr23470", "version-c", "Introduced.", "2026-11-12"));

    const guids = [...rows.values()].map((item) => item.guid.S!);
    // Three pending rows (two of the bill; the "#" keeps H.R. 23470 out), one dispatch marker and three dedupe markers.
    expect(guids.filter((guid) => guid.startsWith(`${billId}#`)).sort()).toEqual([
      `${billId}#alert`,
      `${billId}#passed`,
    ]);
    expect(rows.size).toBe(3 + 1 + 3);
  });
});
