import { describe, expect, it } from 'vitest';

import { isSameUtcDay, utcDayWindow } from './dns-diagnostics.js';

describe('UTC daily DNS diagnostic policy', () => {
  it('uses a stable UTC day bucket across local-day boundaries', () => {
    expect(utcDayWindow(new Date('2026-08-30T23:59:59-07:00')).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
  });

  it('only considers timestamps in the same UTC date equivalent', () => {
    expect(isSameUtcDay(new Date('2026-08-30T00:00:00Z'), new Date('2026-08-30T23:59:59Z'))).toBe(
      true,
    );
    expect(isSameUtcDay(new Date('2026-08-30T23:59:59Z'), new Date('2026-08-31T00:00:00Z'))).toBe(
      false,
    );
  });
});
