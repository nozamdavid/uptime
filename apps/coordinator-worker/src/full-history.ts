import { all, type D1Database } from '@uptime/cloudflare';
import {
  createLatencyAccumulator,
  ranges,
  type LatencyAggregateBucket,
  type LatencyObservationRow,
} from '@uptime/api-worker/queries';
import type { RegionId } from '@uptime/regions';

import { buildMonitorSnapshotBase } from './reports.js';
import type { LatencyPayload, LatencyRangeKey, MonitorReportSnapshot } from './report-types.js';

const historyPageSize = 5_000;
const hourMilliseconds = 3_600_000;
const floorHour = (value: number) => Math.floor(value / hourMilliseconds) * hourMilliseconds;

interface HistoryInterval {
  since: string;
  before: string;
}

/** Closed history uses persisted frequencies; only recent or invalidated hours read raw rows. */
export async function buildFullHistoryMonitorSnapshot(
  db: D1Database,
  monitorId: string,
  options: { now: Date; staleAfterSeconds: number },
): Promise<MonitorReportSnapshot | null> {
  const snapshot = await buildMonitorSnapshotBase(db, monitorId, options);
  if (!snapshot) return null;
  const end = options.now.toISOString();
  const rangeKeys = Object.keys(ranges) as LatencyRangeKey[];
  const accumulators = rangeKeys.map((range) => ({
    range,
    since: new Date(options.now.getTime() - ranges[range]).toISOString(),
    accumulator: createLatencyAccumulator(range),
  }));
  const since = new Date(options.now.getTime() - ranges['30d']).toISOString();
  const coverage = await all<{ since: string }>(
    db,
    'SELECT since FROM monitor_latency_coverage WHERE monitor_id = ?',
    [monitorId],
  );
  let intervals: HistoryInterval[] = [
    { since, before: new Date(options.now.getTime() + 1).toISOString() },
  ];
  if (coverage[0] && coverage[0].since <= since) {
    const recentSince = new Date(floorHour(options.now.getTime() - ranges['24h'])).toISOString();
    const historicalSince = new Date(
      Math.ceil(Date.parse(since) / hourMilliseconds) * hourMilliseconds,
    ).toISOString();
    const boundaryHour = new Date(floorHour(options.now.getTime() - ranges['7d'])).toISOString();
    const dirty = await all<{ hour: string }>(
      db,
      `SELECT hour FROM monitor_latency_dirty
       WHERE monitor_id = ? AND hour >= ? AND hour < ? ORDER BY hour`,
      [monitorId, new Date(floorHour(Date.parse(since))).toISOString(), recentSince],
    );
    const rawHours = new Set(dirty.map(({ hour }) => hour));
    // The rolling range starts within an hour. Read that hour exactly rather than
    // including observations before the requested boundary from its aggregate.
    rawHours.add(boundaryHour);
    const historical = await all<{ region_id: RegionId; hour: string; payload: string }>(
      db,
      `SELECT region_id, hour, payload FROM monitor_latency_hourly
       WHERE monitor_id = ? AND hour >= ? AND hour < ? ORDER BY hour DESC, region_id DESC`,
      [monitorId, historicalSince, recentSince],
    );
    for (const row of historical) {
      if (rawHours.has(row.hour)) continue;
      const summaries = JSON.parse(row.payload) as LatencyAggregateBucket[];
      for (const summary of summaries) {
        for (const { since: rangeSince, accumulator } of accumulators) {
          if (summary.at >= rangeSince) accumulator.addAggregate(row.region_id, summary);
        }
      }
    }
    intervals = [
      { since: recentSince, before: new Date(options.now.getTime() + 1).toISOString() },
      ...(since < historicalSince ? [{ since, before: historicalSince }] : []),
      ...[...rawHours].map((hour) => ({
        since: hour < since ? since : hour,
        before: new Date(Date.parse(hour) + hourMilliseconds).toISOString(),
      })),
    ];
    // Merge overlapping boundaries and dirty hours to read every raw row once.
    intervals.sort((left, right) => left.since.localeCompare(right.since));
    const merged: HistoryInterval[] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.since <= previous.before) {
        if (interval.before > previous.before) previous.before = interval.before;
      } else merged.push({ ...interval });
    }
    intervals = merged;
  }
  for (const interval of intervals) {
    let cursor: { startedAt: string; id: string } | undefined;
    while (true) {
      const page: LatencyObservationRow[] = await all<LatencyObservationRow>(
        db,
        `SELECT region_id, success, started_at, id,
         COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value
       FROM observations
       WHERE monitor_id = ? AND started_at >= ?
         AND started_at ${cursor ? '<=' : '<'} ?
         ${cursor ? 'AND (started_at, id) < (?, ?)' : ''}
       ORDER BY started_at DESC, id DESC LIMIT ?`,
        [
          monitorId,
          interval.since,
          cursor?.startedAt ?? interval.before,
          ...(cursor ? [cursor.startedAt, cursor.id] : []),
          historyPageSize,
        ],
      );
      for (const row of page) {
        for (const { since: rangeSince, accumulator } of accumulators) {
          if (row.started_at >= rangeSince) accumulator.add(row);
        }
      }
      if (page.length < historyPageSize) break;
      const last = page.at(-1)!;
      cursor = { startedAt: last.started_at, id: last.id };
    }
  }
  const latencyByRange = Object.fromEntries(
    accumulators.map(({ range, accumulator }) => [
      range,
      {
        ...accumulator.finish(snapshot.summary.monitor.regionIds),
        sampled: false,
        computedAt: end,
      } satisfies LatencyPayload,
    ]),
  );
  return { ...snapshot, latency: latencyByRange['24h']!, latencyByRange };
}
