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
  if (expectedRegions.length === 0 || latest.length === 0) return 'unknown';
  const successes = latest.filter((item) => item.success).length;
  if (successes === latest.length) return 'up';
  if (successes === 0) return 'down';
  return 'degraded';
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}
