/**
 * Bounded concurrency pool. Workers have no `Promise.all` limit, so the
 * coordinator caps in-flight probe requests explicitly.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Concurrency limit must be a positive integer');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

/** Drain all owned work before surfacing failures to a caller that may release its lease. */
export async function drainAll(operations: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Concurrent operations failed');
}
