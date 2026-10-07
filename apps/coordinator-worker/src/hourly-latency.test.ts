import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';

import {
  backfillLatencyDay,
  refreshDirtyLatencyHours,
  type HourlyLatencyBucket,
} from './hourly-latency.js';
import { makePostgresDatabase } from './testing.js';

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
  regions: readonly ('us-east' | 'us-west')[] = ['us-east', 'us-west'],
): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('monitors')}
      (id, name, url, interval_seconds, timeout_ms, next_check_at, updated_at)
     VALUES ($1, 'Example', 'https://example.com/health', 60, 1000, $2, $2)`,
    [id, '2026-09-20T10:00:00.000Z'],
  );
  await insertRows(
    db,
    'monitor_regions',
    ['monitor_id', 'region_id'],
    regions.map((region) => [id, region]),
  );
}

async function seedObservation(
  db: Database,
  row: {
    id: string;
    monitorId: string;
    regionId: 'us-east' | 'us-west';
    scheduledWindow: string;
    startedAt: string;
    success: boolean;
    responseMs: number | null;
    errorCode?: string | null;
    totalMs?: number | null;
  },
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
    [
      [
        row.id,
        row.monitorId,
        row.scheduledWindow,
        'complete',
        1,
        '["us-east"]',
        'https://example.com/health',
        1000,
        new Date(Date.parse(row.scheduledWindow) + 16_000).toISOString(),
        row.scheduledWindow,
        row.scheduledWindow,
        row.scheduledWindow,
      ],
    ],
  );
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
      'total_ms',
      'error_code',
      'started_at',
      'created_at',
    ],
    [
      [
        row.id,
        row.id,
        row.monitorId,
        row.regionId,
        row.scheduledWindow,
        row.success ? 'success' : 'http_failure',
        row.success ? 1 : 0,
        row.success ? 200 : 503,
        row.responseMs,
        row.totalMs ?? null,
        row.errorCode ?? null,
        row.startedAt,
        row.startedAt,
      ],
    ],
  );
}

function makeCase() {
  const db = fixture.db;
  const monitorId = `latency-${crypto.randomUUID()}`;
  let counter = 0;
  const observe = async (
    startedAt: string,
    value: number | null,
    options: { region?: 'us-east' | 'us-west'; success?: boolean; id?: string } = {},
  ) => {
    counter += 1;
    const id = options.id ?? `observation-${counter}`;
    const window = new Date(
      Date.parse('2026-09-01T00:00:00.000Z') + counter * 60_000,
    ).toISOString();
    await seedObservation(db, {
      id,
      monitorId,
      regionId: options.region ?? 'us-east',
      scheduledWindow: window,
      startedAt,
      success: options.success ?? true,
      responseMs: value,
    });
    return id;
  };
  return {
    db,
    monitorId,
    observe,
    async stored() {
      const rows = (
        await db.query<{ hour: string; region_id: string; payload: string }>(
          `SELECT hour, region_id, payload FROM ${db.table('monitor_latency_hourly')}
           ORDER BY hour, region_id`,
        )
      ).rows;
      return rows.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as HourlyLatencyBucket[],
      }));
    },
    async dirty() {
      return (
        await db.query<{ hour: string }>(
          `SELECT hour FROM ${db.table('monitor_latency_dirty')} ORDER BY hour`,
        )
      ).rows;
    },
  };
}

async function clearFixture(): Promise<void> {
  await fixture.db.query(`DELETE FROM ${fixture.db.table('monitor_latency_hourly')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('monitor_latency_dirty')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('monitor_latency_coverage')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('observations')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('check_runs')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('monitor_regions')}`);
  await fixture.db.query(`DELETE FROM ${fixture.db.table('monitors')}`);
}

async function dropFailureTrigger(): Promise<void> {
  await fixture.adminDb.query(
    `DROP TRIGGER IF EXISTS fail_hourly ON ${fixture.adminDb.table('monitor_latency_hourly')}`,
  );
  await fixture.adminDb.query(
    `DROP FUNCTION IF EXISTS ${fixture.adminDb.schema}.fail_hourly_func()`,
  );
}

describe('persisted hourly latency', () => {
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
  }, 300_000);

  afterEach(async () => {
    await dropFailureTrigger();
    await clearFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  it('keeps exact fractional frequencies, null samples, timeout values, and maximum ties', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.observe('2026-09-26T12:00:00.000Z', 12.25);
    await f.observe('2026-09-26T12:01:00.000Z', 12.25, { success: false });
    await f.observe('2026-09-26T12:02:00.000Z', null, { success: false });
    const timeout = await f.observe('2026-09-26T12:03:00.000Z', null, { success: false });
    await f.db.query(
      `UPDATE ${f.db.table('observations')} SET error_code = 'timeout', total_ms = 1000.5 WHERE id = $1`,
      [timeout],
    );
    await f.observe('2026-09-26T12:04:00.000Z', 1000.5, { id: 'maximum-a' });
    await f.observe('2026-09-26T12:04:00.000Z', 1000.5, { id: 'maximum-z' });
    await f.observe('2026-09-26T12:15:00.000Z', null, { region: 'us-west' });
    await f.observe('2026-09-27T00:00:00.000Z', 99);

    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');

    expect(await f.stored()).toEqual([
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
    expect(await f.dirty()).toEqual([{ hour: '2026-09-27T00:00:00.000Z' }]);
  });

  it('coalesces dirty observations and repairs only a bounded number of closed hours', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.observe('2026-09-27T09:00:00.000Z', 10);
    await f.observe('2026-09-27T09:15:00.000Z', 20);
    await f.observe('2026-09-27T10:00:00.000Z', 30);
    await f.observe('2026-09-27T11:00:00.000Z', 40);
    expect(await f.dirty()).toHaveLength(3);
    const now = new Date('2026-09-27T11:45:00.000Z');

    expect(await refreshDirtyLatencyHours(f.db, { now, limit: 1 })).toBe(1);
    expect((await f.stored())[0]?.payload.map((bucket) => bucket.at)).toEqual([
      '2026-09-27T09:00:00.000Z',
      '2026-09-27T09:15:00.000Z',
    ]);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(1);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect(await f.dirty()).toEqual([{ hour: '2026-09-27T11:00:00.000Z' }]);
  });

  it('selects the latest maximum value before breaking ties by arbitrary observation IDs', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.observe('2026-09-26T12:01:00.000Z', 100, { id: 'maximum-z' });
    await f.observe('2026-09-26T12:02:00.000Z', 100, { id: 'maximum-a' });
    await f.observe('2026-09-26T12:02:00.000Z', 100, { id: 'maximum-a|suffix' });
    await f.observe('2026-09-26T12:14:00.000Z', 1, { id: 'later-smaller-value' });
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    expect((await f.stored())[0]?.payload[0]?.maximum).toEqual({
      value: 100,
      startedAt: '2026-09-26T12:02:00.000Z',
      id: 'maximum-a|suffix',
    });

    await f.db.query(`UPDATE ${f.db.table('observations')} SET id = $1 WHERE id = $2`, [
      'maximum-zz',
      'maximum-a|suffix',
    ]);
    expect(await f.dirty()).toEqual([{ hour: '2026-09-26T12:00:00.000Z' }]);
    await refreshDirtyLatencyHours(f.db, { now: new Date('2026-09-27T12:00:00.000Z') });
    expect((await f.stored())[0]?.payload[0]?.maximum?.id).toBe('maximum-zz');
  });

  it('repairs both buckets when a correction moves an observation and removes empty hours', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    const id = await f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    await f.db.query(
      `UPDATE ${f.db.table('observations')} SET started_at = $1, region_id = $2, response_ms = $3 WHERE id = $4`,
      ['2026-09-26T10:45:00.000Z', 'us-west', 5.5, id],
    );
    expect(await f.dirty()).toEqual([
      { hour: '2026-09-26T09:00:00.000Z' },
      { hour: '2026-09-26T10:00:00.000Z' },
    ]);
    await refreshDirtyLatencyHours(f.db, { now: new Date('2026-09-27T12:00:00.000Z') });
    expect(await f.stored()).toHaveLength(1);
    expect((await f.stored())[0]?.region_id).toBe('us-west');
    expect((await f.stored())[0]?.payload[0]?.histogram).toEqual([[5.5, 1]]);

    await f.db.query(`DELETE FROM ${f.db.table('observations')} WHERE id = $1`, [id]);
    await refreshDirtyLatencyHours(f.db, { now: new Date('2026-09-27T12:00:00.000Z') });
    expect(await f.stored()).toEqual([]);
    expect(await f.dirty()).toEqual([]);
  });

  it('rebuilds days idempotently and preserves existing coverage', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.observe('2026-09-26T23:59:59.999Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    const before = await f.stored();
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-25');
    expect(await f.stored()).toEqual(before);
    expect(
      (await f.db.query(`SELECT * FROM ${f.db.table('monitor_latency_coverage')}`)).rows,
    ).toEqual([{ monitor_id: f.monitorId, since: '1970-01-01T00:00:00.000Z' }]);
  });

  it('rolls back replacement and preserves dirty work when aggregation fails', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    const id = await f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    const before = await f.stored();
    await f.db.query(`UPDATE ${f.db.table('observations')} SET response_ms = 20 WHERE id = $1`, [
      id,
    ]);
    await fixture.adminDb.query(
      `CREATE OR REPLACE FUNCTION ${fixture.adminDb.schema}.fail_hourly_func()
       RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'aggregation unavailable'; END; $$ LANGUAGE plpgsql`,
    );
    await fixture.adminDb.query(
      `CREATE TRIGGER fail_hourly BEFORE INSERT ON ${fixture.adminDb.table('monitor_latency_hourly')}
       FOR EACH ROW EXECUTE FUNCTION ${fixture.adminDb.schema}.fail_hourly_func()`,
    );

    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-09-26')).rejects.toThrow(
      'aggregation unavailable',
    );
    expect(await f.stored()).toEqual(before);
    expect(await f.dirty()).toEqual([{ hour: '2026-09-26T09:00:00.000Z' }]);
  });

  it('does not publish coverage for an existing monitor during a partial backfill', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.db.query(
      `DELETE FROM ${f.db.table('monitor_latency_coverage')} WHERE monitor_id = $1`,
      [f.monitorId],
    );
    await f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    expect(
      (await f.db.query(`SELECT * FROM ${f.db.table('monitor_latency_coverage')}`)).rows,
    ).toEqual([]);
  });

  it('reclaims expired rows in bounded batches without rebuilding old observations', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    for (let index = 0; index < 110; index += 1) {
      const at = new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 3_600_000).toISOString();
      await f.observe(at, index);
    }
    for (const day of ['01', '02', '03', '04', '05'])
      await backfillLatencyDay(f.db, f.monitorId, `2026-08-${day}`);
    await f.db.query(
      `UPDATE ${f.db.table('observations')} SET response_ms = 1 WHERE monitor_id = $1`,
      [f.monitorId],
    );
    expect((await f.dirty()).length).toBe(110);
    expect((await f.stored()).length).toBe(110);

    const now = new Date('2026-09-27T12:00:00.000Z');
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect((await f.dirty()).length).toBe(10);
    expect((await f.stored()).length).toBe(10);
    expect(await refreshDirtyLatencyHours(f.db, { now })).toBe(0);
    expect(await f.dirty()).toEqual([]);
    expect(await f.stored()).toEqual([]);
  });

  it('cascades monitor deletion without leaving dirty keys or violating foreign keys', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await f.observe('2026-09-26T09:00:00.000Z', 10);
    await backfillLatencyDay(f.db, f.monitorId, '2026-09-26');
    await f.db.query(`DELETE FROM ${f.db.table('monitors')} WHERE id = $1`, [f.monitorId]);
    expect(await f.stored()).toEqual([]);
    expect(await f.dirty()).toEqual([]);
  });

  it('rejects invalid dates and unbounded repair limits', async () => {
    const f = makeCase();
    await seedMonitor(f.db, f.monitorId);
    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-02-30')).rejects.toThrow('valid UTC');
    await expect(backfillLatencyDay(f.db, f.monitorId, '2026-9-1')).rejects.toThrow('valid UTC');
    await expect(refreshDirtyLatencyHours(f.db, { now: new Date(), limit: 0 })).rejects.toThrow(
      'repair limit',
    );
  });
});
