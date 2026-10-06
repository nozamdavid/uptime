import { describe, expect, it } from 'vitest';
import type { MonitorSummary } from '@uptime/contracts';

import {
  defaultMonitorSort,
  sortMonitorSummaries,
  type MonitorSortKey,
} from './monitor-list-sort.js';

function summary(
  name: string,
  intervalSeconds: number,
  regions: number,
  requests: number,
  status: MonitorSummary['status'] = 'up',
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
    status,
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

  it('sorts down first, then degraded, then by name by default', () => {
    const mixed = [
      summary('Bravo', 60, 1, 100, 'up'),
      summary('Charlie', 60, 1, 100, 'down'),
      summary('Delta', 60, 1, 100, 'degraded'),
      summary('Alpha', 60, 1, 100, 'down'),
    ];
    const sorted = defaultMonitorSort(mixed);
    expect(sorted.map((item) => item.monitor.name)).toEqual(['Alpha', 'Charlie', 'Delta', 'Bravo']);
  });
});
