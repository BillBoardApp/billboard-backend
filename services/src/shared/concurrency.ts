/**
 * Maps `items` through `fn` with at most `limit` calls in flight, returning
 * results in input order.
 *
 * On the first rejection no further items are started; calls already in
 * flight are allowed to settle (so no work outlives the Lambda invocation),
 * then the first error is rethrown.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> => {
  if (!(limit >= 1)) {
    throw new RangeError(`mapWithConcurrency limit must be >= 1 (got ${limit})`);
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };

  const workerCount = Math.min(Math.floor(limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failed) throw firstError;
  return results;
};
