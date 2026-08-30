import { describe, expect, it } from 'vitest';

import { calculateTargetChecksPerDay } from './estimate.js';
import { estimateRequestSchema, monitorCreateSchema, regionIds } from './index.js';

describe('calculateTargetChecksPerDay', () => {
  it.each([
    [1, 60, 1_440],
    [3, 60, 4_320],
    [3, 300, 864],
    [2, 900, 192],
    [1, 1_800, 48],
    [3, 3_600, 72],
    [9, 60, 12_960],
  ] as const)(
    '%i regions every %i seconds yields %i target checks',
    (count, interval, expected) => {
      const selectedRegionIds = regionIds.slice(0, count);
      expect(
        calculateTargetChecksPerDay({ regionIds: selectedRegionIds, intervalSeconds: interval }),
      ).toEqual({
        regionCount: count,
        intervalSeconds: interval,
        targetChecksPerDay: expected,
        excludes: ['redirects', 'manual-checks'],
      });
    },
  );

  it('rejects duplicate monitor regions and selections larger than the registry', () => {
    const base = {
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 1_000,
    };
    expect(
      monitorCreateSchema.safeParse({ ...base, regionIds: ['us-east', 'us-east'] }).success,
    ).toBe(false);
    expect(
      estimateRequestSchema.safeParse({
        intervalSeconds: 60,
        regionIds: ['us-east', 'us-east'],
      }).success,
    ).toBe(false);
    expect(
      estimateRequestSchema.safeParse({
        intervalSeconds: 60,
        regionIds: [...regionIds, 'unknown-tenth-region'],
      }).success,
    ).toBe(false);
  });

  it('defaults monitor sharing to private and accepts an explicit public toggle', () => {
    const base = {
      url: 'https://example.com',
      regionIds: ['us-east'],
      intervalSeconds: 60,
      timeoutMs: 1_000,
    };
    expect(monitorCreateSchema.parse(base).isPublic).toBe(false);
    expect(monitorCreateSchema.parse({ ...base, isPublic: true }).isPublic).toBe(true);
  });
});
