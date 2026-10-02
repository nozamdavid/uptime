import { describe, expect, it } from 'vitest';

import { checkIntervalPresets, timeoutConstraints } from './index.js';

describe('monitor limits', () => {
  it('uses one-minute intervals through 15 minutes, then five-minute intervals through 60', () => {
    expect(checkIntervalPresets.slice(0, 15)).toEqual(
      Array.from({ length: 15 }, (_, index) => (index + 1) * 60),
    );
    expect(checkIntervalPresets.slice(15)).toEqual(
      Array.from({ length: 9 }, (_, index) => (index + 4) * 300),
    );
  });

  it('bounds editor timeouts to the probe-supported range', () => {
    expect(timeoutConstraints).toEqual({ minimumMs: 1_000, maximumMs: 30_000 });
  });
});
