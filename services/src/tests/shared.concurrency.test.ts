import { mapWithConcurrency } from "../shared/concurrency";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("mapWithConcurrency", () => {
  it("preserves input order even when later items finish first", async () => {
    const delays = [30, 5, 20, 1, 10];
    const result = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${index}:${ms}`;
    });
    expect(result).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  it("never runs more than `limit` calls at once and uses the full limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (item % 3) + 1));
      active -= 1;
      return item;
    });

    expect(peak).toBe(4);
  });

  it("runs sequentially with limit 1", async () => {
    const events: string[] = [];
    await mapWithConcurrency(["a", "b", "c"], 1, async (item) => {
      events.push(`start ${item}`);
      await flush();
      events.push(`end ${item}`);
    });
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("accepts synchronous mappers and passes the index", async () => {
    await expect(mapWithConcurrency([10, 20, 30], 2, (item, index) => item + index)).resolves.toEqual([10, 21, 32]);
  });

  it("handles an empty list without calling fn", async () => {
    const fn = jest.fn();
    await expect(mapWithConcurrency([], 5, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("allows a limit larger than the list, including Infinity", async () => {
    await expect(mapWithConcurrency([1, 2], 50, async (n) => n * 2)).resolves.toEqual([2, 4]);
    await expect(mapWithConcurrency([1, 2], Number.POSITIVE_INFINITY, async (n) => n * 2)).resolves.toEqual([2, 4]);
  });

  it.each([0, -1, Number.NaN, 0.5])("rejects an invalid limit %p", async (limit) => {
    await expect(mapWithConcurrency([1], limit, async (n) => n)).rejects.toBeInstanceOf(RangeError);
  });

  it("stops starting new items after a failure, lets in-flight calls settle, then rethrows the first error", async () => {
    const slow = deferred();
    const started: number[] = [];
    const finished: number[] = [];
    const boom = new Error("boom");

    const pending = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await slow.promise;
      } else if (item === 1) {
        throw boom;
      }
      finished.push(item);
      return item;
    });

    let settled = false;
    pending
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });

    await flush();
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);

    slow.resolve();
    await expect(pending).rejects.toBe(boom);
    expect(finished).toEqual([0]);
    expect(started).toEqual([0, 1]);
  });

  it("reports the first error when several items fail", async () => {
    const first = new Error("first");
    const pending = mapWithConcurrency([1, 2, 3], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item * 5));
      throw item === 1 ? first : new Error(`later ${item}`);
    });
    await expect(pending).rejects.toBe(first);
  });
});
