import type { MonitorSummary } from '@uptime/contracts';
import { monitorDisplayName } from './monitor-format.js';

export type MonitorSortKey = 'name' | 'frequency' | 'regions' | 'requests';
export type MonitorSortDirection = 'ascending' | 'descending';

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
