import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';
import type { ReportConfig } from './env.js';
import { runReportJob } from './report-job.js';
import { reportCohortPointerKey } from './publisher.js';
import { FakeR2 } from './testing-r2.js';
import { makePostgresDatabase } from './testing.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const log = { warn: () => undefined, error: () => undefined };
let fixture: Awaited<ReturnType<typeof makePostgresDatabase>>;

function config(db: Database, reports: FakeR2 | null): ReportConfig {
  return { db, reports, reportIntervalSeconds: 60, staleAfterSeconds: 180 };
}

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

async function seedMonitor(db: Database, index: number): Promise<string> {
  const id = `report-monitor-${index}`;
  await db.query(
    `INSERT INTO ${db.table('monitors')}
      (id, name, url, interval_seconds, timeout_ms, is_public, public_slug, next_check_at, updated_at)
     VALUES ($1, 'Example', 'https://example.com/health', 60, 1000, 1, $2, $3, $3)`,
    [id, `standalone-${index}`, now.toISOString()],
  );
  await db.query(
    `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id) VALUES ($1, 'us-east')`,
    [id],
  );
  return id;
}

async function seedRound(db: Database, monitorId: string, index: number): Promise<string> {
  const id = `report-run-${index}`;
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
      (id, monitor_id, window_started_at, status, expected_region_count, expected_regions,
       monitor_url, timeout_ms, deadline_at, created_at, completed_at, finalized_at)
     VALUES ($1, $2, $3, 'complete', 1, '[\"us-east\"]', 'https://example.com/health',
       1000, $4, $3, $3, $3)`,
    [id, monitorId, now.toISOString(), new Date(now.getTime() + 16_000).toISOString()],
  );
  return id;
}

async function seedFleet(db: Database, size: number): Promise<void> {
  const monitors = Array.from({ length: size }, (_, index) => [
    `report-monitor-${index}`,
    'Example',
    'https://example.com/health',
    60,
    1000,
    1,
    `standalone-${index}`,
    now.toISOString(),
    now.toISOString(),
  ]);
  await insertRows(
    db,
    'monitors',
    [
      'id',
      'name',
      'url',
      'interval_seconds',
      'timeout_ms',
      'is_public',
      'public_slug',
      'next_check_at',
      'updated_at',
    ],
    monitors,
  );
  await insertRows(
    db,
    'monitor_regions',
    ['monitor_id', 'region_id'],
    monitors.map(([id]) => [id, 'us-east']),
  );
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
    monitors.map(([id], index) => [
      `report-run-${index}`,
      id,
      now.toISOString(),
      'complete',
      1,
      '[\"us-east\"]',
      'https://example.com/health',
      1000,
      new Date(now.getTime() + 16_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ]),
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
      'started_at',
      'created_at',
    ],
    monitors.map(([id], index) => [
      `report-observation-${index}`,
      `report-run-${index}`,
      id,
      'us-east',
      now.toISOString(),
      'success',
      1,
      200,
      120,
      now.toISOString(),
      now.toISOString(),
    ]),
  );
}

async function count(db: Database, table: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM ${db.table(table)}`,
  );
  return result.rows[0]!.count;
}

async function clearFixture(db: Database): Promise<void> {
  for (const table of [
    'report_publications',
    'monitor_latency_hourly',
    'monitor_latency_dirty',
    'monitor_latency_coverage',
    'report_latency_changes',
    'observations',
    'check_runs',
    'monitor_regions',
    'monitors',
  ])
    await db.query(`DELETE FROM ${db.table(table)}`);
}

function guardRetiredFeed(db: Database): Database {
  return {
    ...db,
    async query<T extends object>(sql: string, values?: readonly unknown[]) {
      if (sql.includes('report_latency_changes')) throw new Error('Retired feed queried');
      return db.query<T>(sql, values);
    },
  };
}

describe('report job status publication', () => {
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
  }, 300_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  beforeEach(async () => {
    await clearFixture(fixture.db);
  });

  it('compacts at most four completed monitor-hours separately from publication metrics', async () => {
    await seedFleet(fixture.db, 6);
    const reports = new FakeR2();
    const result = await runReportJob(config(fixture.db, reports), {
      log,
      now: () => new Date(now.getTime() + 3_600_000),
    });
    expect(result.published).toBe(1);
    expect(await count(fixture.db, 'monitor_latency_hourly')).toBe(4);
    expect(await count(fixture.db, 'monitor_latency_dirty')).toBe(2);
    expect(result.queryWork['hourly-rollups']!.statements).toBeGreaterThan(0);
    expect(result.queryWork['hourly-rollups']!.statements).toBeLessThan(20);
  }, 300_000);

  it('does no individual monitor work for an idle fleet and reports query metrics', async () => {
    await seedFleet(fixture.db, 150);
    const queries: string[] = [];
    const tracked: Database = {
      ...fixture.db,
      async query<T extends object>(sql: string, values?: readonly unknown[]) {
        queries.push(sql);
        return fixture.db.query<T>(sql, values);
      },
    };
    const reports = new FakeR2();
    const cold = await runReportJob(config(tracked, reports), { log, now: () => now });
    expect(cold.published).toBe(1);
    expect(cold.queryWork.reports!.statements).toBeLessThan(25);
    expect(cold.queryWork.reports!).not.toHaveProperty('rowsRead');
    expect(queries.some((query) => query.includes('FROM observations'))).toBe(false);
    expect(
      [...reports.store.keys()].some((key) => key.includes('samples') || key.includes('monitors-')),
    ).toBe(false);
    expect(await count(fixture.db, 'report_latency_changes')).toBe(0);
    const warm = await runReportJob(config(tracked, reports), {
      log,
      now: () => new Date(now.getTime() + 60_000),
    });
    expect(warm.published).toBe(1);
    expect(warm.queryWork.reports!.statements).toBeLessThan(25);
  }, 300_000);

  it('does not read or delete retired feed rows when publication is disabled', async () => {
    await seedFleet(fixture.db, 1);
    await insertRows(
      fixture.db,
      'report_latency_changes',
      ['monitor_id', 'observation_id', 'operation'],
      Array.from({ length: 2_500 }, (_, index) => ['obsolete', `observation-${index}`, 0]),
    );
    const before = await count(fixture.db, 'report_latency_changes');
    await runReportJob(config(fixture.db, null), {
      log,
      now: () => now,
      publicationDisabled: true,
    });
    expect(await count(fixture.db, 'report_latency_changes')).toBe(before);
  }, 300_000);

  it('publishes and handles missing storage without the retired feed table', async () => {
    const missingFixture = await makePostgresDatabase();
    try {
      await seedMonitor(missingFixture.db, 1);
      const runId = await seedRound(missingFixture.db, 'report-monitor-1', 1);
      await insertRows(
        missingFixture.db,
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
          'started_at',
          'created_at',
        ],
        [
          [
            'report-observation-1',
            runId,
            'report-monitor-1',
            'us-east',
            now.toISOString(),
            'success',
            1,
            200,
            120,
            now.toISOString(),
            now.toISOString(),
          ],
        ],
      );
      await missingFixture.adminDb.query(
        `DROP TABLE ${missingFixture.adminDb.table('report_latency_changes')}`,
      );
      const guarded = guardRetiredFeed(missingFixture.db);
      const reports = new FakeR2();
      expect(
        (await runReportJob(config(guarded, reports), { log, now: () => now })).published,
      ).toBe(1);
      expect((await runReportJob(config(guarded, reports), { log, now: () => now })).skipped).toBe(
        1,
      );
      expect((await runReportJob(config(guarded, null), { log, now: () => now })).failed).toBe(0);
    } finally {
      await missingFixture.close();
    }
  }, 300_000);

  it('does not write public objects during disabled maintenance', async () => {
    await seedFleet(fixture.db, 1);
    const reports = new FakeR2();
    await runReportJob(config(fixture.db, reports), { log, now: () => now });
    const pointer = reports.store.get(reportCohortPointerKey)!.body;
    await runReportJob(config(fixture.db, reports), {
      log,
      now: () => new Date(now.getTime() + 60_000),
      publicationDisabled: true,
    });
    expect(reports.store.get(reportCohortPointerKey)!.body).toBe(pointer);
  }, 300_000);

  it('records failed query work when publication fails', async () => {
    const reports = new FakeR2();
    reports.put = async () => {
      throw new Error('R2 unavailable');
    };
    await expect(
      runReportJob(config(fixture.db, reports), { log, now: () => now }),
    ).rejects.toMatchObject({
      metrics: { failed: 1, queryWork: { reports: { statements: expect.any(Number) } } },
    });
  }, 300_000);
});
