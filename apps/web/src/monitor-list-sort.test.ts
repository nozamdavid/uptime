import { describe, expect, it } from 'vitest';
import type { MonitorSummary } from '@uptime/contracts';

import { sortMonitorSummaries, type MonitorSortKey } from './monitor-list-sort.js';

function summary(
  name: string,
  intervalSeconds: number,
  regions: number,
  requests: number,
): MonitorSummary {
  return {
    monitor: {
      id: crypto.randomUUID(),
      name,
      url: `https://${name.toLowerCase()}.example.test`,
      regionIds: ['us-east', 'us-west', 'eu-west'].slice(
        0,
        regions,
      ) as MonitorSummary['monitor']['regionIds'],
      intervalSeconds: intervalSeconds as MonitorSummary['monitor']['intervalSeconds'],
      timeoutMs: 10_000,
      enabled: true,
      dnsDiagnosticsEnabled: true,
      isPublic: true,
      publicSlug: null,
      createdAt: '2026-08-30T10:00:00.000Z',
      updatedAt: '2026-08-30T10:00:00.000Z',
    },
    status: 'up',
    latestByRegion: {} as MonitorSummary['latestByRegion'],
    targetChecksPerDay: requests,
  };
}

const items = [summary('Zulu', 300, 2, 576), summary('Alpha', 60, 3, 4_320)];

describe('admin monitor sorting', () => {
  it.each([
    ['name', 'Alpha'],
    ['frequency', 'Alpha'],
    ['regions', 'Zulu'],
    ['requests', 'Zulu'],
  ] satisfies Array<[MonitorSortKey, string]>)('sorts ascending by %s', (key, firstName) => {
    expect(sortMonitorSummaries(items, key, 'ascending')[0]?.monitor.name).toBe(firstName);
  });

  it('reverses the selected ordering', () => {
    expect(sortMonitorSummaries(items, 'name', 'descending')[0]?.monitor.name).toBe('Zulu');
  });
});
