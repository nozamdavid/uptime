import { describe, expect, it, vi } from 'vitest';
import { calculateLatency, ranges, type LatencyObservationRow } from '@uptime/api-worker/queries';

import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';
import { backfillLatencyDay } from './hourly-latency.js';

describe('full-history monitor snapshots', () => {
  it('matches every exact range using closed hours, partial boundaries, and dirty corrections', async () => {
    const { sqlite, db } = makeDatabase();
    const regions = ['us-east', 'us-west', 'eu-west'] as const;
    const monitorId = seedMonitor(sqlite, { isPublic: 1, regions: [...regions] });
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
    for (const [index, startedAt] of times.entries()) {
      const id = `history-${index}`;
      seedRound(sqlite, { id, monitorId, windowStartedAt: startedAt, status: 'complete' });
      for (const [regionIndex, regionId] of regions.entries()) {
        if (regionIndex === 1 && index % 2 === 0) continue;
        seedObservation(sqlite, {
          id: `${id}-${regionIndex}`,
          checkRunId: id,
          monitorId,
          regionId,
          scheduledWindow: startedAt,
          startedAt,
          responseMs: index % 5 === 0 ? null : index % 4 === 0 ? 500.25 : 10.5,
          success: index % 3 !== 0,
          errorCode: index % 5 === 0 ? 'timeout' : null,
        });
      }
    }
    sqlite.prepare("UPDATE observations SET total_ms = 1000.5 WHERE error_code = 'timeout'").run();
    for (let day = Date.parse('2026-08-28T00:00:00.000Z'); day < now.getTime(); day += 86_400_000)
      await backfillLatencyDay(db, monitorId, new Date(day).toISOString().slice(0, 10));
    sqlite
      .prepare('INSERT OR REPLACE INTO monitor_latency_coverage (monitor_id, since) VALUES (?, ?)')
      .run(monitorId, '2026-08-28T00:00:00.000Z');
    // A correction and a deletion leave their persisted summaries stale.
    sqlite.prepare('UPDATE observations SET response_ms = 2500.25 WHERE id = ?').run('history-3-0');
    sqlite.prepare('DELETE FROM observations WHERE id = ?').run('history-7-2');
    const rows = sqlite
      .prepare(
        `SELECT region_id, success, started_at, id,
        COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value
        FROM observations WHERE monitor_id = ? ORDER BY started_at DESC, id DESC`,
      )
      .all(monitorId) as unknown as LatencyObservationRow[];
    const rawIntervals: unknown[][] = [];
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes('COALESCE(response_ms') && sql.includes('FROM observations')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          rawIntervals.push(values);
          return bind(...values);
        };
      }
      return statement;
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
  });

  it('includes older history past a page boundary without losing tied timestamps', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { isPublic: 1, regions: ['us-east', 'us-west'] });
    // Existing monitors have no coverage until their migration backfill finishes.
    sqlite.prepare('DELETE FROM monitor_latency_coverage WHERE monitor_id = ?').run(monitorId);
    const now = new Date('2026-09-27T12:00:00.000Z');
    const rows: LatencyObservationRow[] = [];
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
      seedRound(sqlite, { id, monitorId, windowStartedAt: window, status: 'complete' });
      seedObservation(sqlite, {
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
    const rawQueryShapes: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('COALESCE(response_ms') && sql.includes('FROM observations'))
        rawQueryShapes.push(sql);
      return originalPrepare(sql);
    });
    const snapshot = await buildFullHistoryMonitorSnapshot(db, monitorId, {
      now,
      staleAfterSeconds: 120,
    });
    expect(rawQueryShapes.length).toBeGreaterThan(1);
    for (const sql of rawQueryShapes)
      expect(sql.match(/started_at\s*(?:<=|<)\s*\?/g)).toHaveLength(1);
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
  });

  it('returns null for a removed monitor', async () => {
    const { db } = makeDatabase();
    expect(
      await buildFullHistoryMonitorSnapshot(db, 'missing', {
        now: new Date(),
        staleAfterSeconds: 120,
      }),
    ).toBeNull();
  });
});
