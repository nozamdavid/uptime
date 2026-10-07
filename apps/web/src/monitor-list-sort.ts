import type { MonitorSummary } from '@uptime/contracts';
import { monitorDisplayName } from './monitor-format.js';

export type MonitorSortKey = 'status' | 'name' | 'frequency' | 'regions' | 'requests';
export type MonitorSortDirection = 'ascending' | 'descending';

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function statusRank(summary: MonitorSummary): number {
  if (!summary.monitor.enabled) return 4;
  switch (summary.status) {
    case 'down':
      return 0;
    case 'degraded':
      return 1;
    case 'up':
      return 2;
    case 'unknown':
      return 3;
    default:
      return 2;
  }
}

export function defaultMonitorSort(items: readonly MonitorSummary[]): MonitorSummary[] {
  return [...items].sort((left, right) => {
    const rankDiff = statusRank(left) - statusRank(right);
    if (rankDiff !== 0) return rankDiff;
    return nameCollator.compare(
      monitorDisplayName(left.monitor),
      monitorDisplayName(right.monitor),
    );
  });
}

export function sortMonitorSummaries(
  items: readonly MonitorSummary[],
  key: MonitorSortKey,
  direction: MonitorSortDirection,
): MonitorSummary[] {
  const multiplier = direction === 'ascending' ? 1 : -1;
  return [...items].sort((left, right) => {
    const comparison = compare(left, right, key);
    if (comparison !== 0) return comparison * multiplier;
    return nameCollator.compare(
      monitorDisplayName(left.monitor),
      monitorDisplayName(right.monitor),
    );
  });
}

function compare(left: MonitorSummary, right: MonitorSummary, key: MonitorSortKey) {
  switch (key) {
    case 'status':
      return statusRank(left) - statusRank(right);
    case 'name':
      return nameCollator.compare(
        monitorDisplayName(left.monitor),
        monitorDisplayName(right.monitor),
      );
    case 'frequency':
      return left.monitor.intervalSeconds - right.monitor.intervalSeconds;
    case 'regions':
      return left.monitor.regionIds.length - right.monitor.regionIds.length;
    case 'requests':
      return left.targetChecksPerDay - right.targetChecksPerDay;
  }
}
