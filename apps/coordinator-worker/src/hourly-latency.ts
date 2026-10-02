import { all, batch, type D1Database } from '@uptime/cloudflare';
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
 * Keep exact value frequencies and quarter-hour chart summaries. All source
 * reads and replacements run inside one D1 batch transaction, so an arriving
 * correction either participates in this build or leaves a fresh dirty key.
 * SQLite's single-MAX aggregate selects bare columns from the maximizing row.
 * Each quarter's frequency rows have distinct values, so maximum_key belongs
 * to its unique highest value. ISO timestamps cannot contain the separator.
 */
export const hourlyLatencyAggregateSql = `
  INSERT INTO monitor_latency_hourly (monitor_id, hour, region_id, payload)
  WITH source AS (
    SELECT id, region_id, success, started_at,
      COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value,
      strftime('%Y-%m-%dT%H:00:00.000Z', started_at) AS hour,
      strftime('%Y-%m-%dT%H:', started_at)
        || printf('%02d', (CAST(strftime('%M', started_at) AS INTEGER) / 15) * 15)
        || ':00.000Z' AS quarter
    FROM observations
    WHERE monitor_id = ? AND started_at >= ? AND started_at < ?
  ), frequencies AS (
    SELECT region_id, hour, quarter, value, COUNT(*) AS frequency, SUM(success) AS successes,
      MAX(started_at || '|' || id) AS maximum_key
    FROM source GROUP BY region_id, hour, quarter, value
  ), quarters AS (
    SELECT region_id, hour, quarter, SUM(frequency) AS samples, SUM(successes) AS successes,
      json_group_array(json_array(value, frequency)) FILTER (WHERE value IS NOT NULL) AS histogram,
      MAX(value) AS maximum_value, maximum_key
    FROM frequencies GROUP BY region_id, hour, quarter
  )
  SELECT ?, hour, region_id, json_group_array(json_object(
    'at', quarter, 'sampleCount', samples, 'successCount', successes,
    'histogram', json(histogram),
    'maximum', CASE WHEN maximum_value IS NULL THEN NULL ELSE json_object(
      'value', maximum_value,
      'startedAt', substr(maximum_key, 1, instr(maximum_key, '|') - 1),
      'id', substr(maximum_key, instr(maximum_key, '|') + 1)
    ) END
  ))
  FROM quarters GROUP BY hour, region_id
`;

async function replaceHours(
  db: D1Database,
  monitorId: string,
  from: string,
  until: string,
): Promise<void> {
  await batch(db, latencyHourReplacementStatements(monitorId, from, until));
}

/** Shared transactional statements for the Worker and the historical CLI. */
export function latencyHourReplacementStatements(
  monitorId: string,
  from: string,
  until: string,
): Array<{ sql: string; values: readonly unknown[] }> {
  return [
    {
      sql: 'DELETE FROM monitor_latency_hourly WHERE monitor_id = ? AND hour >= ? AND hour < ?',
      values: [monitorId, from, until],
    },
    { sql: hourlyLatencyAggregateSql, values: [monitorId, from, until, monitorId] },
    {
      sql: 'DELETE FROM monitor_latency_dirty WHERE monitor_id = ? AND hour >= ? AND hour < ?',
      values: [monitorId, from, until],
    },
  ];
}

/** Rebuild one UTC day; callers commit coverage after all required days finish. */
export async function backfillLatencyDay(
  db: D1Database,
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
  db: D1Database,
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
      sql: `DELETE FROM monitor_latency_hourly WHERE (monitor_id, hour, region_id) IN (
        SELECT monitor_id, hour, region_id FROM monitor_latency_hourly
        WHERE hour < ? ORDER BY hour LIMIT 100
      )`,
      values: [expiredBefore],
    },
    {
      sql: `DELETE FROM monitor_latency_dirty WHERE (monitor_id, hour) IN (
        SELECT monitor_id, hour FROM monitor_latency_dirty
        WHERE hour < ? ORDER BY hour LIMIT 100
      )`,
      values: [expiredBefore],
    },
  ]);
  const closedBefore = options.now.toISOString().slice(0, 13) + ':00:00.000Z';
  const dirty = await all<{ monitor_id: string; hour: string }>(
    db,
    `SELECT monitor_id, hour FROM monitor_latency_dirty
     WHERE hour >= ? AND hour < ? ORDER BY hour, monitor_id LIMIT ?`,
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
