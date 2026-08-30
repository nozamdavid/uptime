import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter } from './concurrency.js';

describe('shared probe concurrency', () => {
  it('caps simultaneous work and releases a slot after a failure', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const jobs = gates.map((gate, index) =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(index);
        await gate.promise;
        active -= 1;
        if (index === 0) throw new Error('synthetic failure');
      }),
    );
    // Observe the intentionally failing job immediately so the test checks slot
    // release rather than producing an unhandled-rejection warning.
    void jobs[0]!.catch(() => undefined);

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1]);
    gates[0]!.resolve();
    await waitFor(() => started.includes(2));
    expect(started).toContain(2);
    gates.slice(1).forEach((gate) => gate.resolve());
    await expect(Promise.allSettled(jobs)).resolves.toHaveLength(5);
    expect(peak).toBe(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for queued work');
}
