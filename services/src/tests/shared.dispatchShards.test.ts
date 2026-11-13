import { randomUUID } from "node:crypto";
import {
  allDispatchShardPartitionValues,
  DEFAULT_DISPATCH_SHARD_COUNT,
  dispatchShardIndex,
  dispatchShardPartitionValue,
  isDispatchPartitionValue,
  parseDispatchShardCount,
} from "../shared/dispatchShards";

describe("dispatch marker shards (CAP-02)", () => {
  it("maps a user id to the same shard every time, on every runtime", () => {
    // Fixed values: changing the hash would strand markers written by the previous version. The ids are synthetic,
    // shaped like a Cognito sub and an identity-pool id.
    expect(dispatchShardIndex("user-1", 8)).toBe(4);
    expect(dispatchShardIndex("user-2", 8)).toBe(7);
    expect(dispatchShardIndex("11111111-1111-4111-8111-111111111111", 8)).toBe(5);
    expect(dispatchShardIndex("us-east-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 8)).toBe(6);
    expect(dispatchShardIndex("user-2", 16)).toBe(15);
    expect(dispatchShardIndex("user-2", 1)).toBe(0);
    expect(dispatchShardPartitionValue("__dispatch__", "user-1", 8)).toBe("__dispatch__#4");
    for (let i = 0; i < 5; i += 1) {
      expect(dispatchShardIndex("user-1", 8)).toBe(4);
    }
  });

  it("spreads users evenly across the shards", () => {
    const shardCount = 8;
    const users = 16_000;
    const counts = new Array<number>(shardCount).fill(0);
    for (let i = 0; i < users; i += 1) {
      const index = dispatchShardIndex(randomUUID(), shardCount);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(shardCount);
      counts[index] += 1;
    }
    const expected = users / shardCount;
    // Each shard within 10% of an even split (about 7 standard deviations; a skewed hash fails this).
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.1);
    }
  });

  it("spreads sequential ids too", () => {
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 8_000; i += 1) counts[dispatchShardIndex(`user-${i}`, 8)] += 1;
    for (const count of counts) expect(Math.abs(count - 1_000) / 1_000).toBeLessThan(0.15);
  });

  it("lists every shard partition value", () => {
    expect(allDispatchShardPartitionValues("__dispatch__", 3)).toEqual([
      "__dispatch__#0",
      "__dispatch__#1",
      "__dispatch__#2",
    ]);
  });

  it("parses DISPATCH_SHARD_COUNT with a default of 8", () => {
    expect(DEFAULT_DISPATCH_SHARD_COUNT).toBe(8);
    expect(parseDispatchShardCount(undefined)).toBe(8);
    expect(parseDispatchShardCount("")).toBe(8);
    expect(parseDispatchShardCount("16")).toBe(16);
    expect(parseDispatchShardCount(" 4 ")).toBe(4);
    expect(parseDispatchShardCount("0")).toBe(8);
    expect(parseDispatchShardCount("-3")).toBe(8);
    expect(parseDispatchShardCount("2.5")).toBe(8);
    expect(parseDispatchShardCount("lots")).toBe(8);
    expect(parseDispatchShardCount("100000")).toBe(8);
  });

  it("recognises the legacy and sharded partition values and nothing else", () => {
    expect(isDispatchPartitionValue("__dispatch__", "__dispatch__")).toBe(true);
    expect(isDispatchPartitionValue("__dispatch__#0", "__dispatch__")).toBe(true);
    expect(isDispatchPartitionValue("__dispatch__#15", "__dispatch__")).toBe(true);
    expect(isDispatchPartitionValue("__dispatch__#", "__dispatch__")).toBe(false);
    expect(isDispatchPartitionValue("__dispatch__#x", "__dispatch__")).toBe(false);
    expect(isDispatchPartitionValue("__dispatch__#1#2", "__dispatch__")).toBe(false);
    expect(isDispatchPartitionValue("__dedupe__", "__dispatch__")).toBe(false);
    expect(isDispatchPartitionValue("user-1", "__dispatch__")).toBe(false);
    expect(isDispatchPartitionValue(3, "__dispatch__")).toBe(false);
  });
});
