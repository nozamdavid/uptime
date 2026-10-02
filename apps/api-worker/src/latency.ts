import { regionIds, type RegionId } from '@uptime/regions';

export const ranges = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
} as const;
export type RangeKey = keyof typeof ranges;

const bucketSeconds = {
  '1h': [300, 60],
  '24h': [900, 300],
  '7d': [3_600, 900],
  '30d': [21_600, 3_600],
} as const;

export interface LatencyObservationRow {
  region_id: RegionId;
  success: number;
  value: number | null;
  started_at: string;
  id: string;
}

/** Lossless latency frequencies for one region in a quarter-hour interval. */
export interface LatencyAggregateBucket {
  at: string;
  sampleCount: number;
  successCount: number;
  histogram: Array<[number, number]>;
  maximum: { value: number; startedAt: string; id: string } | null;
}

interface Bucket {
  epoch: number;
  regionId: RegionId;
  sum: number;
  count: number;
  success: boolean;
}

const average = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

const bucketAverage = (bucket: Bucket) => (bucket.count === 0 ? null : bucket.sum / bucket.count);

function percentile(sorted: readonly [number, number][], percentage: number): number | null {
  const count = sorted.reduce((total, [, frequency]) => total + frequency, 0);
  const rank = Math.max(1, Math.ceil((percentage / 100) * count));
  let seen = 0;
  for (const [value, frequency] of sorted) {
    seen += frequency;
    if (seen >= rank) return value;
  }
  return null;
}

/** Calculate identical latency statistics for exact API rows and bounded report samples. */
export function calculateLatency(
  rows: readonly LatencyObservationRow[],
  configuredRegions: readonly RegionId[],
  range: RangeKey,
) {
  const accumulator = createLatencyAccumulator(range);
  for (const row of rows) accumulator.add(row);
  return accumulator.finish(configuredRegions);
}

/** Consume raw rows or persisted frequencies without expanding historical samples. */
export function createLatencyAccumulator(range: RangeKey) {
  const regionalBuckets = new Map<string, Bucket>();
  const aggregateBuckets = new Map<string, Bucket>();
  const perRegion = new Map<
    RegionId,
    { values: Map<number, number>; sampleCount: number; successCount: number }
  >();
  let maximum: LatencyObservationRow | null = null;
  let minimum: number | null = null;
  function add(row: LatencyObservationRow) {
    addAggregate(row.region_id, {
      at: row.started_at,
      sampleCount: 1,
      successCount: row.success === 1 ? 1 : 0,
      histogram: row.value === null ? [] : [[Number(row.value), 1]],
      maximum:
        row.value === null ? null : { value: row.value, startedAt: row.started_at, id: row.id },
    });
  }
  function addAggregate(regionId: RegionId, summary: LatencyAggregateBucket) {
    const epoch = Math.floor(Date.parse(summary.at) / 1_000);
    let sum = 0;
    let count = 0;
    for (const [value, frequency] of summary.histogram) {
      sum += value * frequency;
      count += frequency;
    }
    for (const [seconds, target] of [
      [bucketSeconds[range][0], regionalBuckets],
      [bucketSeconds[range][1], aggregateBuckets],
    ] as const) {
      const bucketEpoch = Math.floor(epoch / seconds) * seconds;
      const key = `${bucketEpoch}:${regionId}`;
      const bucket = target.get(key) ?? {
        epoch: bucketEpoch,
        regionId,
        sum: 0,
        count: 0,
        success: true,
      };
      bucket.sum += sum;
      bucket.count += count;
      bucket.success = bucket.success && summary.successCount === summary.sampleCount;
      target.set(key, bucket);
    }
    const stats = perRegion.get(regionId) ?? {
      values: new Map<number, number>(),
      sampleCount: 0,
      successCount: 0,
    };
    stats.sampleCount += summary.sampleCount;
    stats.successCount += summary.successCount;
    for (const [value, frequency] of summary.histogram) {
      stats.values.set(value, (stats.values.get(value) ?? 0) + frequency);
      minimum = minimum === null ? value : Math.min(minimum, value);
    }
    if (summary.maximum) {
      const row = {
        region_id: regionId,
        value: summary.maximum.value,
        started_at: summary.maximum.startedAt,
        id: summary.maximum.id,
        success: 1,
      };
      if (
        !maximum ||
        row.value > maximum.value! ||
        (row.value === maximum.value &&
          (row.started_at > maximum.started_at ||
            (row.started_at === maximum.started_at && row.id > maximum.id)))
      )
        maximum = row;
    }
    perRegion.set(regionId, stats);
  }
  function finish(configuredRegions: readonly RegionId[]) {
    const points = [...regionalBuckets.values()]
      .sort(
        (left, right) => left.epoch - right.epoch || left.regionId.localeCompare(right.regionId),
      )
      .map((bucket) => ({
        observedAt: new Date(bucket.epoch * 1_000).toISOString(),
        regionId: bucket.regionId,
        responseMs: bucketAverage(bucket),
        success: bucket.success,
      }));
    // Balance regions equally even when their sample counts differ.
    const aggregateByEpoch = new Map<number, Bucket[]>();
    for (const bucket of aggregateBuckets.values()) {
      const buckets = aggregateByEpoch.get(bucket.epoch) ?? [];
      buckets.push(bucket);
      aggregateByEpoch.set(bucket.epoch, buckets);
    }
    const aggregatePoints = [...aggregateByEpoch]
      .sort(([left], [right]) => left - right)
      .map(([epoch, buckets]) => ({
        observedAt: new Date(epoch * 1_000).toISOString(),
        responseMs: average(
          buckets.map(bucketAverage).filter((value): value is number => value !== null),
        ),
        success: buckets.every((bucket) => bucket.success),
      }));
    const stats = regionIds
      .filter((regionId) => configuredRegions.includes(regionId) || perRegion.has(regionId))
      .map((regionId) => {
        const stat = perRegion.get(regionId);
        const sorted = [...(stat?.values ?? [])].sort(([left], [right]) => left - right);
        return {
          regionId,
          sampleCount: stat?.sampleCount ?? 0,
          successCount: stat?.successCount ?? 0,
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          p99Ms: percentile(sorted, 99),
        };
      });
    return {
      points,
      stats,
      aggregatePoints,
      aggregateStats: {
        averageResponseMs: average(
          [...perRegion.values()]
            .map((stat) => {
              let sum = 0;
              let count = 0;
              for (const [value, frequency] of stat.values) {
                sum += value * frequency;
                count += frequency;
              }
              return count === 0 ? null : sum / count;
            })
            .filter((value): value is number => value !== null),
        ),
        maximumResponseMs: maximum?.value ?? null,
        maximumResponseRegionId: maximum?.region_id ?? null,
        minimumResponseMs: minimum,
      },
    };
  }
  return { add, addAggregate, finish };
}
