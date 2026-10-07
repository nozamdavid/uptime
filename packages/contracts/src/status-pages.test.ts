import { describe, expect, it } from 'vitest';

import { statusPageFontFamilies, statusPageSaveSchema } from './index.js';

const firstMonitor = '10000000-0000-4000-8000-000000000001';

describe('status page input', () => {
  it('accepts ordered groups and monitor ids', () => {
    expect(
      statusPageSaveSchema.parse({
        title: 'System status',
        groups: [{ title: 'Core', monitorIds: [firstMonitor] }],
      }),
    ).toEqual({
      title: 'System status',
      groups: [{ title: 'Core', monitorIds: [firstMonitor], width: 'full', showBadges: true }],
    });
  });

  it('accepts only canonical font families and leaves omitted choices unset', () => {
    expect(statusPageFontFamilies).toHaveLength(10);
    const input = { title: 'System status', groups: [] };
    expect(statusPageSaveSchema.parse(input).fontFamily).toBeUndefined();
    for (const fontFamily of statusPageFontFamilies) {
      expect(statusPageSaveSchema.parse({ ...input, fontFamily }).fontFamily).toBe(fontFamily);
    }
    expect(() => statusPageSaveSchema.parse({ ...input, fontFamily: 'Comic Sans MS' })).toThrow();
  });

  it('rejects the same monitor in multiple groups', () => {
    expect(() =>
      statusPageSaveSchema.parse({
        title: 'System status',
        groups: [
          { title: 'Core', monitorIds: [firstMonitor] },
          { title: 'Other', monitorIds: [firstMonitor] },
        ],
      }),
    ).toThrow(/only once/);
  });

  it('accepts more than 100 monitors on one page and in one group', () => {
    const monitorIds = Array.from(
      { length: 101 },
      (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(
      statusPageSaveSchema.parse({
        title: 'System status',
        groups: [{ title: 'All monitors', monitorIds }],
      }),
    ).toMatchObject({ groups: [{ monitorIds }] });
  });
});
