import type { AggregateStatus, ObservationStatus, RegionId } from '@uptime/contracts';

export interface LatestObservation {
  regionId: RegionId;
  status: ObservationStatus;
  success: boolean;
}

export function deriveAggregateStatus(
  expectedRegions: readonly RegionId[],
  latest: readonly LatestObservation[],
): AggregateStatus {
  if (latest.length === 0) return 'unknown';
  const successes = latest.filter((item) => item.success).length;
  const failures = latest.length - successes;
  const missing = Math.max(0, expectedRegions.length - latest.length);
  if (missing === 0 && successes === expectedRegions.length) return 'up';
  // A strict target-failure majority that no missing result can overturn is down.
  if (failures > expectedRegions.length / 2 && failures > missing) return 'down';
  if (successes > 0) return 'degraded';
  return missing > 0 ? 'unknown' : 'down';
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}
