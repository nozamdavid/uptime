import { describe, expect, it } from 'vitest';

import {
  backfillLatencyDay,
  refreshDirtyLatencyHours,
  type HourlyLatencyBucket,
} from './hourly-latency.js';
import { makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';

function fixture() {
  const { sqlite, db } = makeDatabase();
  const monitorId = seedMonitor(sqlite, { regions: ['us-east', 'us-west'] });
  let counter = 0;
  function observe(
    startedAt: string,
    value: number | null,
    options: { region?: 'us-east' | 'us-west'; success?: boolean; id?: string } = {},
  ) {
    counter += 1;
    const id = options.id ?? `observation-${counter}`;
    // Scheduled windows stay unique even when started timestamps tie.
    const window = new Date(
      Date.parse('2026-09-01T00:00:00.000Z') + counter * 60_000,
    ).toISOString();
    seedRound(sqlite, { id, monitorId, windowStartedAt: window, status: 'complete' });
    seedObservation(sqlite, {
      id,
      checkRunId: id,
      monitorId,
      regionId: options.region ?? 'us-east',
      scheduledWindow: window,
      startedAt,
      success: options.success ?? true,
      responseMs: value,
    });
    return id;
  }
  function stored() {
    return (
      sqlite
        .prepare(
          'SELECT hour, region_id, payload FROM monitor_latency_hourly ORDER BY hour, region_id',
        )
        .all() as Array<{ hour: string; region_id: string; payload: string }>
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as HourlyLatencyBucket[] }));
  }
  function dirty() {
    return sqlite.prepare('SELECT hour FROM monitor_latency_dirty ORDER BY hour').all();
  }
  return { sqlite, db, monitorId, observe, stored, dirty };
}

describe('persisted hourly latency', () => {
  it('keeps exact fractional frequencies, null samples, timeout values, and maximum ties', async () => {
    const f = fixture();
    f.observe('2026-09-26T12:00:00.000Z', 12.25);
    f.observe('2026-09-26T12:01:00.000Z', 12.25, { success: false });
    f.observe('2026-09-26T12:02:00.000Z', null, { success: false });
    const timeout = f.observe('2026-09-26T12:03:00.000Z', null, { success: false });
    f.sqlite
      .prepare("UPDATE observations SET error_code = 'timeout', total_ms = 1000.5 WHERE id = ?")
      .run(timeout);
    f.observe('2026-09-26T12:04:00.000Z', 1000.5, { id: 'maximum-a' });
    f.observe('2026-09-26T12:04:00.000Z', 1000.5, { id: 'maximum-z' });
    f.observe('2026-09-26T12:15:00.000Z', null, { region: 'us-west' });
    f.observe('2026-09-27T00:00:00.000Z', 99);

    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');

    expect(f.stored()).toEqual([
      {
        hour: '2026-09-26T12:00:00.000Z',
        region_id: 'us-east',
        payload: [
          {
            at: '2026-09-26T12:00:00.000Z',
            sampleCount: 6,
            successCount: 3,
            histogram: [
              [12.25, 2],
              [1000.5, 3],
            ],
            maximum: { value: 1000.5, startedAt: '2026-09-26T12:04:00.000Z', id: 'maximum-z' },
          },
        ],
      },
      {
        hour: '2026-09-26T12:00:00.000Z',
        region_id: 'us-west',
        payload: [
          {
            at: '2026-09-26T12:15:00.000Z',
            sampleCount: 1,
            successCount: 1,
            histogram: [],
            maximum: null,
          },
        ],
      },
    ]);
    expect(f.dirty()).toEqual([{ hour: '2026-09-27T00:00:00.000Z' }]);
  });

  it('coalesces dirty observations and repairs only a bounded number of closed hours', async () => {
    const f = fixture();
    f.observe('2026-09-27T09:00:00.000Z', 10);
    f.observe('2026-09-27T09:15:00.000Z', 20);
    f.observe('2026-09-27T10:00:00.000Z', 30);
    f.observe('2026-09-27T11:00:00.000Z', 40);
    expect(f.dirty()).toHaveLength(3);
    const now = new Date('2026-09-27T11:45:00.000Z');

    expect(await refreshDirtyLatencyHours(f.db, { now, limit: 1 })).toBe(1);
    expect(f.stored()[0]?.payload.map((bucket) => bucket.at)).toEqual([
      '2026-09-27T09:00:00.000Z',
      '2026-09-27T09:15:00.000Z',
    ]);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(1);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect(f.dirty()).toEqual([{ hour: '2026-09-27T11:00:00.000Z' }]);
  });

  it('selects the latest maximum value before breaking ties by arbitrary observation IDs', async () => {
    const f = fixture();
    f.observe('2026-09-26T12:01:00.000Z', 100, { id: 'maximum-z' });
    f.observe('2026-09-26T12:02:00.000Z', 100, { id: 'maximum-a' });
    f.observe('2026-09-26T12:02:00.000Z', 100, { id: 'maximum-a|suffix' });
    f.observe('2026-09-26T12:14:00.000Z', 1, { id: 'later-smaller-value' });
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    expect(f.stored()[0]?.payload[0]?.maximum).toEqual({
      value: 100,
      startedAt: '2026-09-26T12:02:00.000Z',
      id: 'maximum-a|suffix',
    });
  });

  it('repairs both buckets when a correction moves an observation and removes empty hours', async () => {
    const f = fixture();
    const id = f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    f.sqlite
      .prepare(
        'UPDATE observations SET started_at = ?, region_id = ?, response_ms = ? WHERE id = ?',
      )
      .run('2026-09-26T10:45:00.000Z', 'us-west', 5.5, id);
    expect(f.dirty()).toEqual([
      { hour: '2026-09-26T09:00:00.000Z' },
      { hour: '2026-09-26T10:00:00.000Z' },
    ]);
    await refreshDirtyLatencyHours(f.db, { now: new Date('2026-09-27T12:00:00.000Z') });
    expect(f.stored()).toHaveLength(1);
    expect(f.stored()[0]?.region_id).toBe('us-west');
    expect(f.stored()[0]?.payload[0]?.histogram).toEqual([[5.5, 1]]);

    f.sqlite.prepare('DELETE FROM observations WHERE id = ?').run(id);
    await refreshDirtyLatencyHours(f.db, { now: new Date('2026-09-27T12:00:00.000Z') });
    expect(f.stored()).toEqual([]);
    expect(f.dirty()).toEqual([]);
  });

  it('rebuilds days idempotently and preserves existing coverage', async () => {
    const f = fixture();
    f.observe('2026-09-26T23:59:59.999Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    const before = f.stored();
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-25');
    expect(f.stored()).toEqual(before);
    expect(f.sqlite.prepare('SELECT * FROM monitor_latency_coverage').all()).toEqual([
      { monitor_id: f.monitorId, since: '1970-01-01T00:00:00.000Z' },
    ]);
  });

  it('rolls back replacement and preserves dirty work when aggregation fails', async () => {
    const f = fixture();
    const id = f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    const before = f.stored();
    f.sqlite.prepare('UPDATE observations SET response_ms = 20 WHERE id = ?').run(id);
    f.sqlite.exec(`CREATE TRIGGER fail_hourly BEFORE INSERT ON monitor_latency_hourly
      BEGIN SELECT RAISE(ABORT, 'aggregation unavailable'); END`);

    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-09-26')).rejects.toThrow(
      'aggregation unavailable',
    );
    expect(f.stored()).toEqual(before);
    expect(f.dirty()).toEqual([{ hour: '2026-09-26T09:00:00.000Z' }]);
  });

  it('does not publish coverage for an existing monitor during a partial backfill', async () => {
    const f = fixture();
    f.sqlite.prepare('DELETE FROM monitor_latency_coverage WHERE monitor_id = ?').run(f.monitorId);
    f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    expect(f.sqlite.prepare('SELECT * FROM monitor_latency_coverage').all()).toEqual([]);
  });

  it('reclaims expired rows in bounded batches without rebuilding old observations', async () => {
    const f = fixture();
    for (let index = 0; index < 110; index += 1) {
      const at = new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 3_600_000).toISOString();
      f.observe(at, index);
    }
    for (const day of ['01', '02', '03', '04', '05']) {
      await backfillLatencyDay(f.db, f.monitorId, `2026-08-${day}`);
    }
    f.sqlite
      .prepare('UPDATE observations SET response_ms = 1 WHERE monitor_id = ?')
      .run(f.monitorId);
    expect(f.dirty()).toHaveLength(110);
    expect(f.stored()).toHaveLength(110);

    const now = new Date('2026-09-27T12:00:00.000Z');
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect(f.dirty()).toHaveLength(10);
    expect(f.stored()).toHaveLength(10);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect(f.dirty()).toEqual([]);
    expect(f.stored()).toEqual([]);
  });

  it('cascades monitor deletion without leaving dirty keys or violating foreign keys', async () => {
    const f = fixture();
    f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    f.sqlite.prepare('DELETE FROM monitors WHERE id = ?').run(f.monitorId);
    expect(f.stored()).toEqual([]);
    expect(f.dirty()).toEqual([]);
  });

  it('rejects invalid dates and unbounded repair limits', async () => {
    const f = fixture();
    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-02-30')).rejects.toThrow('valid UTC');
    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-9-1')).rejects.toThrow('valid UTC');
    await expect(refreshDirtyLatencyHours(f.db, { now: new Date(), limit: 0 })).rejects.toThrow(
      'repair limit',
    );
  });
});
