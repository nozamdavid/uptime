import { pgAll as all, pgBatch as batch, type Database } from '@uptime/cloudflare/postgres';
import type { RegionId } from '@uptime/regions';

export interface HourlyLatencyBucket {
  at: string;
  sampleCount: number;
  successCount: number;
  histogram: Array<[number, number]>;
  maximum: { value: number; startedAt: string; id: string } | null;
}

export interface HourlyLatencyRow {
  monitor_id: string;
  region_id: RegionId;
  hour: string;
  payload: string;
}

/**
 * Keep exact frequencies and quarter-hour summaries. Winner ordering includes
 * value, timestamp and arbitrary TEXT id, without encoding ids in a separator.
 */
export function hourlyLatencyAggregateSql(db: Database): string {
  return `
  INSERT INTO ${db.table('monitor_latency_hourly')} (monitor_id, hour, region_id, payload)
  WITH source AS (
    SELECT id, region_id, success, started_at,
      COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value,
      substr(started_at, 1, 13) || ':00:00.000Z' AS hour,
      substr(started_at, 1, 14)
        || lpad(((substr(started_at, 15, 2)::integer / 15) * 15)::text, 2, '0')
        || ':00.000Z' AS quarter
    FROM ${db.table('observations')}
    WHERE monitor_id = $1 AND started_at >= $2 AND started_at < $3
  ), frequencies AS (
    SELECT region_id, hour, quarter, value, COUNT(*)::integer AS frequency, SUM(success)::integer AS successes
    FROM source GROUP BY region_id, hour, quarter, value
  ), quarters AS (
    SELECT region_id, hour, quarter, SUM(frequency) AS samples, SUM(successes) AS successes,
      COALESCE(jsonb_agg(jsonb_build_array(value, frequency) ORDER BY value) FILTER (WHERE value IS NOT NULL), '[]'::jsonb) AS histogram
    FROM frequencies GROUP BY region_id, hour, quarter
  ), winners AS (
    SELECT DISTINCT ON (region_id, hour, quarter) region_id, hour, quarter, value, started_at, id
    FROM source WHERE value IS NOT NULL
    ORDER BY region_id, hour, quarter, value DESC, started_at DESC, id DESC
  )
  SELECT $1, q.hour, q.region_id, jsonb_agg(jsonb_build_object(
    'at', q.quarter, 'sampleCount', q.samples, 'successCount', q.successes,
    'histogram', q.histogram,
    'maximum', CASE WHEN w.value IS NULL THEN NULL ELSE jsonb_build_object(
      'value', w.value, 'startedAt', w.started_at, 'id', w.id
    ) END
  ) ORDER BY q.quarter)::text
  FROM quarters q LEFT JOIN winners w USING (region_id, hour, quarter)
  GROUP BY q.hour, q.region_id
`;
}

async function replaceHours(
  db: Database,
  monitorId: string,
  from: string,
  until: string,
): Promise<void> {
  await batch(db, latencyHourReplacementStatements(db, monitorId, from, until));
}

/** Shared transactional statements for the Worker and the historical CLI. */
export function latencyHourReplacementStatements(
  db: Database,
  monitorId: string,
  from: string,
  until: string,
): Array<{ sql: string; values: readonly unknown[] }> {
  return [
    {
      // Delete first: concurrent trigger inserts wait on this key and create a
      // new marker after commit, even if their observation missed our snapshot.
      sql: `WITH locked AS MATERIALIZED (
        SELECT monitor_id, hour FROM ${db.table('monitor_latency_dirty')}
        WHERE monitor_id = $1 AND hour >= $2 AND hour < $3
        ORDER BY monitor_id, hour FOR UPDATE
      ) DELETE FROM ${db.table('monitor_latency_dirty')} dirty USING locked
        WHERE dirty.monitor_id = locked.monitor_id AND dirty.hour = locked.hour`,
      values: [monitorId, from, until],
    },
    {
      sql: `DELETE FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = $1 AND hour >= $2 AND hour < $3`,
      values: [monitorId, from, until],
    },
    { sql: hourlyLatencyAggregateSql(db), values: [monitorId, from, until] },
  ];
}

/** Rebuild one UTC day; callers commit coverage after all required days finish. */
export async function backfillLatencyDay(
  db: Database,
  monitorId: string,
  day: string,
): Promise<void> {
  const from = `${day}T00:00:00.000Z`;
  const date = new Date(from);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== from
  )
    throw new Error('Latency backfill day must be a valid UTC YYYY-MM-DD date');
  await replaceHours(db, monitorId, from, new Date(date.getTime() + 86_400_000).toISOString());
}

/** Repair a bounded number of fully closed monitor-hours, oldest first. */
export async function refreshDirtyLatencyHours(
  db: Database,
  options: { now: Date; limit?: number },
): Promise<number> {
  const limit = options.limit ?? 4;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Latency repair limit must be an integer from 1 to 100');
  const expiredBefore = new Date(options.now.getTime() - 31 * 86_400_000).toISOString();
  // Historical inserts and retention deletes can leave old dirty keys. Reclaim
  // bounded batches without scanning or rebuilding data outside chart history.
  await batch(db, [
    {
      sql: `DELETE FROM ${db.table('monitor_latency_hourly')} WHERE (monitor_id, hour, region_id) IN (
        SELECT monitor_id, hour, region_id FROM ${db.table('monitor_latency_hourly')}
        WHERE hour < $1 ORDER BY hour LIMIT 100
      )`,
      values: [expiredBefore],
    },
    {
      sql: `DELETE FROM ${db.table('monitor_latency_dirty')} WHERE (monitor_id, hour) IN (
        SELECT monitor_id, hour FROM ${db.table('monitor_latency_dirty')}
        WHERE hour < $1 ORDER BY hour LIMIT 100
      )`,
      values: [expiredBefore],
    },
  ]);
  const closedBefore = options.now.toISOString().slice(0, 13) + ':00:00.000Z';
  const dirty = await all<{ monitor_id: string; hour: string }>(
    db,
    `SELECT monitor_id, hour FROM ${db.table('monitor_latency_dirty')}
     WHERE hour >= $1 AND hour < $2 ORDER BY hour, monitor_id LIMIT $3`,
    [expiredBefore, closedBefore, limit],
  );
  for (const row of dirty) {
    await replaceHours(
      db,
      row.monitor_id,
      row.hour,
      new Date(Date.parse(row.hour) + 3_600_000).toISOString(),
    );
  }
  return dirty.length;
}
