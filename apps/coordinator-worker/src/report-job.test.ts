import { describe, expect, it } from 'vitest';
import type { ReportConfig } from './env.js';
import { runReportJob } from './report-job.js';
import { reportCohortPointerKey } from './publisher.js';
import { FakeR2 } from './testing-r2.js';
import { count, makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const log = { warn: () => undefined, error: () => undefined };

function config(db: ReportConfig['db'], reports: FakeR2 | null): ReportConfig {
  return {
    db,
    reports,
    reportIntervalSeconds: 60,
    staleAfterSeconds: 180,
  };
}

function seedFleet(sqlite: ReturnType<typeof makeDatabase>['sqlite'], size: number) {
  for (let index = 0; index < size; index += 1) {
    const id = seedMonitor(sqlite, { isPublic: 1, publicSlug: `standalone-${index}` });
    seedRound(sqlite, {
      id: `run-${index}`,
      monitorId: id,
      windowStartedAt: now.toISOString(),
      status: 'complete',
    });
    seedObservation(sqlite, {
      checkRunId: `run-${index}`,
      monitorId: id,
      regionId: 'us-east',
      scheduledWindow: now.toISOString(),
      success: true,
      responseMs: 120,
    });
  }
}

describe('report job status publication and obsolete feed maintenance', () => {
  it('compacts at most four completed monitor-hours separately from publication metrics', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 6);
    const reports = new FakeR2();
    const result = await runReportJob(config(db, reports), {
      log,
      now: () => new Date(now.getTime() + 3_600_000),
    });
    expect(result.published).toBe(1);
    expect(count(sqlite, 'monitor_latency_hourly')).toBe(4);
    expect(count(sqlite, 'monitor_latency_dirty')).toBe(2);
    expect(result.queryWork['hourly-rollups']!.statements).toBeGreaterThan(0);
    expect(result.queryWork['hourly-rollups']!.statements).toBeLessThan(20);
  });

  it('does no individual monitor work for an idle fleet and reports query metrics', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 150);
    const queries: string[] = [];
    const tracked = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    };
    const reports = new FakeR2();
    const cold = await runReportJob(config(tracked, reports), { log, now: () => now });
    expect(cold.published).toBe(1);
    expect(cold.queryWork.reports!.statements).toBeLessThan(25);
    expect(cold.queryWork.reports!.rowsRead).toBeLessThan(10);
    expect(queries.some((query) => query.includes('FROM observations'))).toBe(false);
    expect(
      [...reports.store.keys()].some((key) => key.includes('samples') || key.includes('monitors-')),
    ).toBe(false);
    expect(count(sqlite, 'report_latency_changes')).toBe(0);
    const warm = await runReportJob(config(tracked, reports), {
      log,
      now: () => new Date(now.getTime() + 60_000),
    });
    expect(warm.published).toBe(1);
    expect(warm.queryWork.reports!.statements).toBeLessThan(25);
  });

  it('cleans obsolete input in batches of at most 2000 even when publication is disabled', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 1);
    for (let index = 0; index < 2500; index += 1)
      sqlite
        .prepare(
          'INSERT INTO report_latency_changes (monitor_id, observation_id, operation) VALUES (?, ?, 0)',
        )
        .run('obsolete', `observation-${index}`);
    const before = count(sqlite, 'report_latency_changes');
    await runReportJob(config(db, null), { log, now: () => now, publicationDisabled: true });
    expect(count(sqlite, 'report_latency_changes')).toBe(before - 2000);
  });

  it('preserves data under another report lease and fences an obsolete owner', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 1);
    sqlite
      .prepare(
        "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'active', '2099-01-01T00:00:00.000Z')",
      )
      .run();
    const before = count(sqlite, 'report_latency_changes');
    await runReportJob(config(db, null), { log, now: () => now });
    expect(count(sqlite, 'report_latency_changes')).toBe(before);
    await expect(
      runReportJob(config(db, null), { log, now: () => now, jobLeaseToken: 'obsolete' }),
    ).rejects.toThrow('lease expired or changed');
    await runReportJob(config(db, null), { log, now: () => now, jobLeaseToken: 'active' });
    expect(count(sqlite, 'report_latency_changes')).toBe(0);
  });

  it('fences cleanup when ownership changes immediately before mutation', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 1);
    sqlite
      .prepare(
        "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'active', '2099-01-01T00:00:00.000Z')",
      )
      .run();
    const guarded = {
      ...db,
      prepare(query: string) {
        if (query.includes('DELETE FROM report_latency_changes'))
          sqlite
            .prepare("UPDATE jobs SET lease_token = 'replacement' WHERE name = 'reports'")
            .run();
        return db.prepare(query);
      },
    };
    const before = count(sqlite, 'report_latency_changes');
    await runReportJob(config(guarded, null), { log, now: () => now, jobLeaseToken: 'active' });
    expect(count(sqlite, 'report_latency_changes')).toBe(before);
  });

  it('does not write public objects during disabled maintenance', async () => {
    const { sqlite, db } = makeDatabase();
    seedFleet(sqlite, 1);
    const reports = new FakeR2();
    await runReportJob(config(db, reports), { log, now: () => now });
    const pointer = reports.store.get(reportCohortPointerKey)!.body;
    await runReportJob(config(db, reports), {
      log,
      now: () => new Date(now.getTime() + 60_000),
      publicationDisabled: true,
    });
    expect(reports.store.get(reportCohortPointerKey)!.body).toBe(pointer);
  });

  it('records failed query work when publication fails', async () => {
    const { db } = makeDatabase();
    const reports = new FakeR2();
    reports.put = async () => {
      throw new Error('R2 unavailable');
    };
    await expect(runReportJob(config(db, reports), { log, now: () => now })).rejects.toMatchObject({
      metrics: { failed: 1, queryWork: { reports: { statements: expect.any(Number) } } },
    });
  });
});
