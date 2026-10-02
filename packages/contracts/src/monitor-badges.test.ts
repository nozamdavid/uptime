import { describe, expect, it } from 'vitest';

import {
  badgeCreateSchema,
  monitorBulkBadgeUpdateSchema,
  uptimeThresholdsSchema,
} from './index.js';

const monitorId = '00000000-0000-4000-8000-000000000001';
const badgeId = '00000000-0000-4000-8000-000000000002';

describe('monitor badges', () => {
  it('validates badge names and bulk assignments', () => {
    expect(badgeCreateSchema.parse({ name: ' API ' })).toEqual({ name: 'API' });
    expect(monitorBulkBadgeUpdateSchema.parse({ monitorIds: [monitorId], badgeId })).toEqual({
      monitorIds: [monitorId],
      badgeId,
    });
    expect(
      monitorBulkBadgeUpdateSchema.safeParse({ monitorIds: [monitorId], badgeId: null }).success,
    ).toBe(true);
  });
});

describe('uptime thresholds', () => {
  it('applies defaults and enforces descending color bands', () => {
    expect(uptimeThresholdsSchema.parse({})).toEqual({
      green: 99.5,
      lightGreen: 99,
      orange: 90,
    });
    expect(
      uptimeThresholdsSchema.safeParse({ green: 99, lightGreen: 99.5, orange: 90 }).success,
    ).toBe(false);
  });
});
