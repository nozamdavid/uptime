import { describe, expect, it } from 'vitest';

import { formatLatency, formatPercentage } from './status-page-format.js';

describe('status page formatting', () => {
  it.each([
    [100, '100%'],
    [99.9999, '100%'],
    [99.12345, '99.123%'],
    [null, '—'],
  ])('formats uptime percentages', (value, expected) => {
    expect(formatPercentage(value)).toBe(expected);
  });

  it.each([
    [123.456, '123.46ms'],
    [120, '120ms'],
    [null, '—'],
  ])('formats average response latency', (value, expected) => {
    expect(formatLatency(value)).toBe(expected);
  });
});
