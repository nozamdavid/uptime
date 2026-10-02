import type { AggregateStatus, ObservationStatus, RegionId } from '@uptime/contracts';

export interface LatestObservation {
  regionId: RegionId;
  status: ObservationStatus;
  success: boolean;
}

/** Missing probe results are a monitoring gap, so an incomplete round is unknown. */
export function deriveAggregateStatus(
  expectedRegions: readonly RegionId[],
  latest: readonly LatestObservation[],
): AggregateStatus {
  if (expectedRegions.length === 0 || latest.length === 0) return 'unknown';
  const latestByRegion = new Map(latest.map((item) => [item.regionId, item]));
  const expectedResults = expectedRegions.map((regionId) => latestByRegion.get(regionId));
  if (expectedResults.some((item) => item === undefined)) return 'unknown';
  const successes = expectedResults.filter((item) => item?.success).length;
  if (successes === expectedResults.length) return 'up';
  if (successes === 0) return 'down';
  return 'degraded';
}
