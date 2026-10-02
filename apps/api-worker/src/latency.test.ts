import { describe, expect, it } from 'vitest';

import {
  calculateLatency,
  createLatencyAccumulator,
  type LatencyObservationRow,
} from './latency.js';

const row = (
  region_id: LatencyObservationRow['region_id'],
  value: number | null,
  success = 1,
  id = 'a',
): LatencyObservationRow => ({
  region_id,
  value,
  success,
  id,
  started_at: '2026-09-27T12:00:00.000Z',
});

describe('shared latency calculation', () => {
  it.each(['7d', '30d'] as const)('combines exact weighted frequencies for %s', (range) => {
    const accumulator = createLatencyAccumulator(range);
    accumulator.addAggregate('us-east', {
      at: '2026-09-27T12:00:00.000Z',
      sampleCount: 102,
      successCount: 101,
      histogram: [
        [10.5, 100],
        [1000.25, 1],
      ],
      maximum: { value: 1000.25, startedAt: '2026-09-27T12:00:00.000Z', id: 'a' },
    });
    accumulator.addAggregate('us-west', {
      at: '2026-09-27T12:00:00.000Z',
      sampleCount: 1,
      successCount: 1,
      histogram: [[1000.25, 1]],
      maximum: { value: 1000.25, startedAt: '2026-09-27T12:00:00.000Z', id: 'b' },
    });
    const rows = [
      ...Array.from({ length: 100 }, () => row('us-east', 10.5)),
      row('us-east', null, 0),
      row('us-east', 1000.25),
      row('us-west', 1000.25, 1, 'b'),
    ];
    expect(accumulator.finish(['eu-west'])).toEqual(calculateLatency(rows, ['eu-west'], range));
    expect(accumulator.finish([]).stats[0]!.p99Ms).toBe(10.5);
    expect(accumulator.finish([]).aggregateStats.maximumResponseRegionId).toBe('us-west');
  });

  it('balances regions, retains failures without latency, and fills configured empty regions', () => {
    const latency = calculateLatency(
      [row('us-east', 10), row('us-east', 30), row('us-west', 100), row('eu-west', null, 0)],
      ['us-east', 'asia-east'],
      '24h',
    );
    expect(latency.aggregatePoints).toEqual([
      {
        observedAt: '2026-09-27T12:00:00.000Z',
        responseMs: 60,
        success: false,
      },
    ]);
    expect(latency.aggregateStats).toEqual({
      averageResponseMs: 60,
      maximumResponseMs: 100,
      maximumResponseRegionId: 'us-west',
      minimumResponseMs: 10,
    });
    expect(latency.stats).toEqual([
      { regionId: 'us-east', sampleCount: 2, successCount: 2, p50Ms: 10, p95Ms: 30, p99Ms: 30 },
      { regionId: 'us-west', sampleCount: 1, successCount: 1, p50Ms: 100, p95Ms: 100, p99Ms: 100 },
      {
        regionId: 'eu-west',
        sampleCount: 1,
        successCount: 0,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
      {
        regionId: 'asia-east',
        sampleCount: 0,
        successCount: 0,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
    ]);
  });

  it('resolves maximum ties by newest timestamp then greatest id regardless of input order', () => {
    const rows = [
      row('us-east', 100, 1, 'z'),
      row('us-west', 100, 1, 'b'),
      row('eu-west', 100, 1, 'a'),
    ];
    rows[0]!.started_at = '2026-09-27T11:59:59.000Z';
    expect(calculateLatency(rows, [], '1h').aggregateStats.maximumResponseRegionId).toBe('us-west');
    expect(calculateLatency([...rows].reverse(), [], '1h')).toEqual(
      calculateLatency(rows, [], '1h'),
    );
  });

  it.each([
    ['1h', 300, 60],
    ['24h', 900, 300],
    ['7d', 3600, 900],
    ['30d', 21600, 3600],
  ] as const)(
    'uses the regional and aggregate bucket contract for %s',
    (range, regional, aggregate) => {
      const sample = row('us-east', 20);
      sample.started_at = '2026-09-27T13:17:21.000Z';
      const latency = calculateLatency([sample], [], range);
      const epoch = Date.parse(sample.started_at) / 1000;
      expect(latency.points[0]!.observedAt).toBe(
        new Date(Math.floor(epoch / regional) * regional * 1000).toISOString(),
      );
      expect(latency.aggregatePoints[0]!.observedAt).toBe(
        new Date(Math.floor(epoch / aggregate) * aggregate * 1000).toISOString(),
      );
    },
  );
});
