import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { calculateLatency, ranges, type LatencyObservationRow } from '@uptime/api-worker/queries';
import type { Database } from '@uptime/cloudflare/postgres';

import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { makePostgresDatabase } from './testing.js';
import { backfillLatencyDay } from './hourly-latency.js';

let fixture: Awaited<ReturnType<typeof makePostgresDatabase>>;

async function insertRows(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 400) {
    const chunk = rows.slice(offset, offset + 400);
    const values = chunk.flat();
    const placeholders = chunk
      .map((_, rowIndex) => {
        const start = rowIndex * columns.length;
        return `(${columns.map((__, columnIndex) => `$${start + columnIndex + 1}`).join(', ')})`;
      })
      .join(',\n');
    await db.query(
      `INSERT INTO ${db.table(table)} (${columns.join(', ')}) VALUES ${placeholders}`,
      values,
    );
  }
}

async function seedMonitor(
  db: Database,
  id: string,
  regions: readonly string[],
  isPublic = 0,
): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('monitors')}
      (id, name, url, interval_seconds, timeout_ms, is_public, next_check_at, updated_at)
     VALUES ($1, 'Example', 'https://example.com/health', 60, 1000, $2, $3, $3)`,
    [id, isPublic, '2026-09-27T00:00:00.000Z'],
  );
  await insertRows(
    db,
    'monitor_regions',
    ['monitor_id', 'region_id'],
    regions.map((regionId) => [id, regionId]),
  );
}

async function seedRounds(
  db: Database,
  monitorId: string,
  rows: readonly { id: string; windowStartedAt: string }[],
): Promise<void> {
  await insertRows(
    db,
    'check_runs',
    [
      'id',
      'monitor_id',
      'window_started_at',
      'status',
      'expected_region_count',
      'expected_regions',
      'monitor_url',
      'timeout_ms',
      'deadline_at',
      'created_at',
      'completed_at',
      'finalized_at',
    ],
    rows.map(({ id, windowStartedAt }) => [
      id,
      monitorId,
      windowStartedAt,
      'complete',
      1,
      '["us-east"]',
      'https://example.com/health',
      1_000,
      new Date(Date.parse(windowStartedAt) + 16_000).toISOString(),
      windowStartedAt,
      windowStartedAt,
      windowStartedAt,
    ]),
  );
}

async function seedObservations(
  db: Database,
  rows: readonly {
    id: string;
    checkRunId: string;
    monitorId: string;
    regionId: string;
    scheduledWindow: string;
    startedAt: string;
    success: boolean;
    responseMs: number | null;
    errorCode?: string | null;
  }[],
): Promise<void> {
  await insertRows(
    db,
    'observations',
    [
      'id',
      'check_run_id',
      'monitor_id',
      'region_id',
      'scheduled_window',
      'status',
      'success',
      'http_status',
      'response_ms',
      'error_code',
      'started_at',
      'created_at',
    ],
    rows.map((row) => [
      row.id,
      row.checkRunId,
      row.monitorId,
      row.regionId,
      row.scheduledWindow,
      row.success ? 'success' : 'http_failure',
      row.success ? 1 : 0,
      row.success ? 200 : 503,
      row.responseMs,
      row.errorCode ?? null,
      row.startedAt,
      row.startedAt,
    ]),
  );
}

describe('full-history monitor snapshots', () => {
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches every exact range using closed hours, partial boundaries, and dirty corrections', async () => {
    const { db } = fixture;
    const regions = ['us-east', 'us-west', 'eu-west'] as const;
    const monitorId = `history-${crypto.randomUUID()}`;
    await seedMonitor(db, monitorId, regions, 1);
    const now = new Date('2026-09-27T00:17:21.000Z');
    const times = [
      '2026-08-28T00:17:20.999Z',
      '2026-08-28T00:17:21.000Z',
      '2026-08-28T00:45:00.000Z',
      '2026-08-29T12:19:00.000Z',
      '2026-09-19T23:59:59.000Z',
      '2026-09-20T00:17:20.999Z',
      '2026-09-20T00:17:21.000Z',
      '2026-09-20T01:15:00.000Z',
      '2026-09-26T00:17:20.999Z',
      '2026-09-26T00:17:21.000Z',
      '2026-09-26T23:17:20.999Z',
      '2026-09-26T23:17:21.000Z',
      '2026-09-27T00:00:00.000Z',
      '2026-09-27T00:17:21.000Z',
      '2026-09-27T00:17:21.001Z',
    ];
    await seedRounds(
      db,
      monitorId,
      times.map((windowStartedAt, index) => ({ id: `history-${index}`, windowStartedAt })),
    );
    await seedObservations(
      db,
      times.flatMap((startedAt, index) => {
        const id = `history-${index}`;
        return regions.flatMap((regionId, regionIndex) => {
          if (regionIndex === 1 && index % 2 === 0) return [];
          return [
            {
              id: `${id}-${regionIndex}`,
              checkRunId: id,
              monitorId,
              regionId,
              scheduledWindow: startedAt,
              startedAt,
              responseMs: index % 5 === 0 ? null : index % 4 === 0 ? 500.25 : 10.5,
              success: index % 3 !== 0,
              errorCode: index % 5 === 0 ? 'timeout' : null,
            },
          ];
        });
      }),
    );
    await db.query(
      `UPDATE ${db.table('observations')} SET total_ms = 1000.5 WHERE error_code = 'timeout'`,
    );
    for (let day = Date.parse('2026-08-28T00:00:00.000Z'); day < now.getTime(); day += 86_400_000)
      await backfillLatencyDay(db, monitorId, new Date(day).toISOString().slice(0, 10));
    await db.query(
      `INSERT INTO ${db.table('monitor_latency_coverage')} (monitor_id, since)
       VALUES ($1, $2) ON CONFLICT (monitor_id) DO UPDATE SET since = EXCLUDED.since`,
      [monitorId, '2026-08-28T00:00:00.000Z'],
    );
    // A correction and a deletion leave their persisted summaries stale.
    await db.query(`UPDATE ${db.table('observations')} SET response_ms = 2500.25 WHERE id = $1`, [
      'history-3-0',
    ]);
    await db.query(`DELETE FROM ${db.table('observations')} WHERE id = $1`, ['history-7-2']);
    const rows = (
      await db.query<LatencyObservationRow>(
        `SELECT region_id, success, started_at, id,
        COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value
        FROM ${db.table('observations')} WHERE monitor_id = $1 ORDER BY started_at DESC, id DESC`,
        [monitorId],
      )
    ).rows;
    const rawIntervals: unknown[][] = [];
    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes('COALESCE(response_ms') && sql.includes('FROM')) {
        rawIntervals.push(values ? [...values] : []);
      }
      return originalQuery(sql, values);
    });
    const snapshot = await buildFullHistoryMonitorSnapshot(db, monitorId, {
      now,
      staleAfterSeconds: 120,
    });
    for (const range of ['1h', '24h', '7d', '30d'] as const) {
      expect(snapshot!.latencyByRange![range]).toEqual({
        ...calculateLatency(
          rows.filter(
            (row) =>
              Date.parse(row.started_at) >= now.getTime() - ranges[range] &&
              row.started_at <= now.toISOString(),
          ),
          regions,
          range,
        ),
        sampled: false,
        computedAt: now.toISOString(),
      });
    }
    expect(rawIntervals.length).toBeGreaterThan(1);
    for (const [, from, before] of rawIntervals)
      expect(Date.parse(String(before)) - Date.parse(String(from))).toBeLessThanOrEqual(
        25 * 3_600_000,
      );
  }, 300_000);

  it('includes older history past a page boundary without losing tied timestamps', async () => {
    const { db } = fixture;
    const monitorId = `history-${crypto.randomUUID()}`;
    await seedMonitor(db, monitorId, ['us-east', 'us-west'], 1);
    // Existing monitors have no coverage until their migration backfill finishes.
    await db.query(`DELETE FROM ${db.table('monitor_latency_coverage')} WHERE monitor_id = $1`, [
      monitorId,
    ]);
    const now = new Date('2026-09-27T12:00:00.000Z');
    const rows: LatencyObservationRow[] = [];
    const roundRows: { id: string; windowStartedAt: string }[] = [];
    const observationRows: {
      id: string;
      checkRunId: string;
      monitorId: string;
      regionId: string;
      scheduledWindow: string;
      startedAt: string;
      success: boolean;
      responseMs: number | null;
    }[] = [];
    for (let index = 0; index < 5_004; index += 1) {
      const id = `observation-${String(index).padStart(5, '0')}`;
      const startedAt =
        index < 5_001
          ? '2026-09-27T11:50:00.000Z'
          : index === 5_001
            ? '2026-09-07T12:00:00.000Z'
            : index === 5_002
              ? '2026-08-01T12:00:00.000Z'
              : '2026-09-28T12:00:00.000Z';
      const window = new Date(now.getTime() - index * 60_000).toISOString();
      const success = index % 17 !== 0;
      const value = index % 19 === 0 ? null : index % 1_000;
      roundRows.push({ id, windowStartedAt: window });
      observationRows.push({
        id,
        checkRunId: id,
        monitorId,
        regionId: 'us-east',
        scheduledWindow: window,
        startedAt,
        success,
        responseMs: value,
      });
      rows.push({ id, region_id: 'us-east', started_at: startedAt, success: +success, value });
    }
    await seedRounds(db, monitorId, roundRows);
    await seedObservations(db, observationRows);
    const rawQueryShapes: string[] = [];
    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes('COALESCE(response_ms') && sql.includes('FROM')) rawQueryShapes.push(sql);
      return originalQuery(sql, values);
    });
    const snapshot = await buildFullHistoryMonitorSnapshot(db, monitorId, {
      now,
      staleAfterSeconds: 120,
    });
    expect(rawQueryShapes.length).toBeGreaterThan(1);
    for (const sql of rawQueryShapes)
      expect(sql.match(/started_at\s*(?:<=|<)\s*\$\d+/g)).toHaveLength(1);
    expect(snapshot).not.toBeNull();
    for (const range of ['1h', '24h', '7d', '30d'] as const) {
      const selected = rows.filter(
        (row) =>
          Date.parse(row.started_at) >= now.getTime() - ranges[range] &&
          row.started_at <= now.toISOString(),
      );
      expect(snapshot!.latencyByRange![range]).toEqual({
        ...calculateLatency(selected, ['us-east', 'us-west'], range),
        sampled: false,
        computedAt: now.toISOString(),
      });
    }
    expect(snapshot!.latencyByRange!['30d']!.stats[0]!.sampleCount).toBe(5_002);
    expect(snapshot!.latencyByRange!['30d']!.points[0]!.observedAt).toContain('2026-09-07');
    expect(snapshot!.latencyByRange!['30d']!.sampleLimit).toBeUndefined();
  }, 300_000);

  it('returns null for a removed monitor', async () => {
    const { db } = fixture;
    expect(
      await buildFullHistoryMonitorSnapshot(db, 'missing', {
        now: new Date(),
        staleAfterSeconds: 120,
      }),
    ).toBeNull();
  });
});
