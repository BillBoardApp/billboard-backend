import type { DynamoDBClient, TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import {
  DEDUPE_TTL_SECONDS,
  DISPATCH_MARKER_TTL_SECONDS,
  PENDING_ROW_TTL_SECONDS,
  writePendingNotification,
  type PendingNotificationStoreConfig,
} from "../shared/pendingNotifications";

/**
 * Project decision D1 (2026-10-07): pending pushes live 24 hours. The three lifetimes written in one
 * transaction must stay in order, or a delivery outage loses pushes (marker gone before its rows: the
 * dispatcher never looks at the user again) or duplicates them (dedupe gone before the row: a redelivered
 * write adds a second pending row).
 */

const HOUR = 3600;

type TransactInput = TransactWriteItemsCommandInput;

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

describe("pending notification lifetimes (D1)", () => {
  test("a pending row lives 24 hours, its dispatch marker 26, its dedupe marker 3 days", () => {
    expect(PENDING_ROW_TTL_SECONDS).toBe(24 * HOUR);
    expect(DISPATCH_MARKER_TTL_SECONDS).toBe(26 * HOUR);
    expect(DEDUPE_TTL_SECONDS).toBe(72 * HOUR);
  });

  test("the marker outlives the row by at least 2 hours, and dedupe lasts at least as long as the row", () => {
    expect(DISPATCH_MARKER_TTL_SECONDS).toBeGreaterThanOrEqual(PENDING_ROW_TTL_SECONDS + 2 * HOUR);
    expect(DEDUPE_TTL_SECONDS).toBeGreaterThanOrEqual(PENDING_ROW_TTL_SECONDS);
    // A failing userNotifierQueue message reaches its DLQ after 5 receives of 720 s: the rows must
    // still exist when it does, so a fixed UserNotifier can still deliver them.
    expect(PENDING_ROW_TTL_SECONDS).toBeGreaterThan(5 * 720);
  });

  test("one write stamps each item with its own lifetime from the same creation time", async () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    jest.spyOn(Date, "now").mockReturnValue(now);
    const sent: TransactInput[] = [];
    const dynamo = { send: jest.fn(async (command: { input: TransactInput }) => sent.push(command.input)) };
    try {
      await expect(
        writePendingNotification(dynamo as Pick<DynamoDBClient, "send">, store, {
          userId: "user-1",
          billId: "BILLS-119hr900",
          billTitle: "A bill",
          category: "Taxes",
          lifeArea: "Money",
          notificationType: "passed",
          sourceRevision: "rev-1",
        }),
      ).resolves.toBe("written");
    } finally {
      jest.restoreAllMocks();
    }

    const createdAt = Math.floor(now / 1000);
    const items = sent[0].TransactItems!.map((entry) => entry.Put!.Item!);
    const byKind = Object.fromEntries(
      items.map((item) => [item.markerType?.S ?? "pending-row", Number(item.ttl.N) - createdAt]),
    );
    expect(byKind).toEqual({
      "notification-dedupe": 72 * HOUR,
      "pending-row": 24 * HOUR,
      "pending-user": 26 * HOUR,
    });
    // Everything else about the write is as before: one transaction of three items.
    expect(sent).toHaveLength(1);
    expect(items).toHaveLength(3);
  });
});
