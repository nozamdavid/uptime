import { describe, expect, it } from 'vitest';

import { buildMonitorSnapshotBase, buildReportCohortData } from './reports.js';
import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { parseReportEnv } from './env.js';
import { publishDueReports, reportCohortIndexKey } from './publisher.js';
import { FakeR2 } from './testing-r2.js';
import { makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const options = { now, staleAfterSeconds: 180 };

function seedReportData(sqlite: ReturnType<typeof makeDatabase>['sqlite']) {
  const monitorId = seedMonitor(sqlite, {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Public status',
    url: 'https://status.example.test/health',
    isPublic: 1,
    publicSlug: 'public-status',
    intervalSeconds: 300,
    regions: ['us-east', 'us-west'],
    updatedAt: '2026-08-30T09:00:00.000Z',
  });
  sqlite.prepare("INSERT INTO badges (id, name, color) VALUES ('b1', 'Core', '#112233')").run();
  sqlite.prepare('UPDATE monitors SET badge_id = ? WHERE id = ?').run('b1', monitorId);
  sqlite
    .prepare(
      `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
        expected_regions, monitor_url, timeout_ms, deadline_at)
       VALUES ('run-1', ?, '2026-09-20T11:59:00.000Z', 'complete', 2,
        '["us-east","us-west"]', 'https://status.example.test/health', 1000,
        '2026-09-20T11:59:16.000Z')`,
    )
    .run(monitorId);
  seedObservation(sqlite, {
    checkRunId: 'run-1',
    monitorId,
    regionId: 'us-east',
    scheduledWindow: '2026-09-20T11:59:00.000Z',
    success: true,
    responseMs: 120,
    startedAt: '2026-09-20T11:59:05.000Z',
  });
  seedObservation(sqlite, {
    checkRunId: 'run-1',
    monitorId,
    regionId: 'us-west',
    scheduledWindow: '2026-09-20T11:59:00.000Z',
    success: false,
    errorCode: 'timeout',
    responseMs: null,
    startedAt: '2026-09-20T11:59:06.000Z',
  });
  return monitorId;
}

describe('monitor report snapshot', () => {
  it('matches the frontend contract and reports degraded status', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    const snapshot = (await buildFullHistoryMonitorSnapshot(db, monitorId, options))!;
    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.generatedAt).toBe(now.toISOString());
    expect(snapshot.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
    expect(snapshot.staleAfterSeconds).toBe(180);
    expect(snapshot.summary.monitor).toMatchObject({
      id: monitorId,
      publicSlug: 'public-status',
      regionIds: ['us-east', 'us-west'],
    });
    expect(snapshot.summary.monitor.badge).toEqual({ id: 'b1', name: 'Core', color: '#112233' });
    expect(snapshot.summary.status).toBe('degraded');
    expect(snapshot.summary.latestByRegion['us-east']).toMatchObject({
      success: true,
      responseMs: 120,
    });
    expect(snapshot.summary.latestByRegion['us-west']).toMatchObject({
      success: false,
      responseMs: null,
    });
    expect(snapshot.summary.targetChecksPerDay).toBe(2 * (86_400 / 300));
    expect(snapshot.latencyByRange?.['24h']).toBeDefined();
    expect(snapshot.latency.stats.map((stat) => stat.regionId)).toEqual(['us-east', 'us-west']);
    expect(snapshot.latency.stats).toEqual([
      {
        regionId: 'us-east',
        sampleCount: 1,
        successCount: 1,
        p50Ms: 120,
        p95Ms: 120,
        p99Ms: 120,
      },
      {
        regionId: 'us-west',
        sampleCount: 1,
        successCount: 0,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
    ]);
    expect(snapshot.latency.aggregateStats).toEqual({
      averageResponseMs: 120,
      maximumResponseMs: 120,
      maximumResponseRegionId: 'us-east',
      minimumResponseMs: 120,
    });
    expect(snapshot.latency.aggregatePoints).toEqual([
      {
        observedAt: '2026-09-20T11:55:00.000Z',
        responseMs: 120,
        success: false,
      },
    ]);
    // Provider configuration and private fields must never be serialized.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('outageThreshold');
    expect(serialized).not.toContain('notificationServiceIds');
    expect(serialized).not.toContain('dnsDiagnosticsEnabled');
  });

  it('returns null for a deleted monitor so publication can be removed', async () => {
    const { db } = makeDatabase();
    expect(await buildMonitorSnapshotBase(db, 'missing', options)).toBeNull();
  });

  it('reports unknown when an expected region is missing from the latest round', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    sqlite
      .prepare("DELETE FROM observations WHERE check_run_id = 'run-1' AND region_id = 'us-west'")
      .run();
    sqlite.prepare("UPDATE check_runs SET status = 'partial' WHERE id = 'run-1'").run();

    const snapshot = (await buildMonitorSnapshotBase(db, monitorId, options))!;
    expect(snapshot.summary.status).toBe('unknown');
    expect(snapshot.summary.latestByRegion['us-east']?.success).toBe(true);
    expect(snapshot.summary.latestByRegion['us-west']).toBeNull();
  });

  it('reports imported partial rounds unknown when their region list is incomplete', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    sqlite
      .prepare("DELETE FROM observations WHERE check_run_id = 'run-1' AND region_id = 'us-west'")
      .run();
    sqlite
      .prepare(
        "UPDATE check_runs SET status = 'partial', expected_regions = '[\"us-east\"]', expected_region_count = 2 WHERE id = 'run-1'",
      )
      .run();

    const snapshot = (await buildMonitorSnapshotBase(db, monitorId, options))!;
    expect(snapshot.summary.status).toBe('unknown');
  });
});

describe('status page report snapshot', () => {
  it('groups monitors into the public response shape', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    sqlite
      .prepare("INSERT INTO status_pages (id, title, public_slug) VALUES ('p1', 'Acme', 'acme')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES ('g1', 'p1', 'Core', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('p1', 'g1', ?, 0)",
      )
      .run(monitorId);

    const snapshot = (await buildReportCohortData(db, options)).statusPages.get('p1')!;
    expect(snapshot.statusPage).toMatchObject({ id: 'p1', title: 'Acme', publicSlug: 'acme' });
    const group = snapshot.statusPage.groups[0]!;
    expect(group).toMatchObject({ id: 'g1', title: 'Core', width: 'full', showBadges: true });
    const monitor = group.monitors[0]!;
    expect(monitor).toMatchObject({
      id: monitorId,
      uptimePercentage: 50,
      status: 'down',
      configuredRegionCount: 2,
      // The failing region is surfaced as an affected region.
      affectedRegionIds: ['us-west'],
      recoveryStatus: 'down',
    });
    expect(monitor.days).toHaveLength(90);
    expect(snapshot.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
  });

  it('builds the public status page index', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    sqlite
      .prepare("INSERT INTO status_pages (id, title, public_slug) VALUES ('p1', 'Acme', 'acme')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES ('g1', 'p1', 'Core', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('p1', 'g1', ?, 0)",
      )
      .run(monitorId);
    sqlite
      .prepare(
        `INSERT INTO report_publications
           (report_key, kind, status_page_id, object_key, schema_version,
            latest_observation_at, status)
         VALUES ('status-page:p1', 'status-page', 'p1', 'public/status-pages/acme.json', '1',
           '2026-09-20T11:59:06.000Z', 'complete')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO report_publications
           (report_key, kind, object_key, schema_version, latest_observation_at, status)
         VALUES ('status-page:deleted', 'status-page', 'public/status-pages/deleted.json', '1',
           '2026-09-20T12:00:00.000Z', 'complete')`,
      )
      .run();
    const reports = new FakeR2();
    await publishDueReports(parseReportEnv({ DB: db, REPORTS: reports }), now, console);
    const index = JSON.parse(reports.store.get(reportCohortIndexKey(String(now.getTime())))!.body);
    expect(index.statusPages).toEqual([{ id: 'p1', title: 'Acme', publicSlug: 'acme' }]);
    expect(index.schemaVersion).toBe('1');
    expect(index.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
  });

  it('uses current incomplete-round evidence instead of historical uptime for status', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    sqlite
      .prepare("DELETE FROM observations WHERE check_run_id = 'run-1' AND region_id = 'us-west'")
      .run();
    sqlite.prepare("UPDATE check_runs SET status = 'partial' WHERE id = 'run-1'").run();
    sqlite.prepare("INSERT INTO status_pages (id, title) VALUES ('p1', 'Acme')").run();
    sqlite
      .prepare(
        "INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES ('g1', 'p1', 'Core', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('p1', 'g1', ?, 0)",
      )
      .run(monitorId);

    const snapshot = (await buildReportCohortData(db, options)).statusPages.get('p1')!;
    expect(snapshot.statusPage.groups[0]!.monitors[0]!.status).toBe('unknown');
  });
});

describe('uptime aggregation in snapshots', () => {
  function addCohortMember(
    sqlite: ReturnType<typeof makeDatabase>['sqlite'],
    monitorId: string,
    position = 0,
  ) {
    sqlite
      .prepare("INSERT OR IGNORE INTO status_pages (id, title) VALUES ('cohort', 'Cohort')")
      .run();
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO status_page_groups (id, status_page_id, title, position) VALUES ('cohort-group', 'cohort', 'Core', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('cohort', 'cohort-group', ?, ?)",
      )
      .run(monitorId, position);
  }

  it('counts only received observations and weights by exact counts', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    // Finalize the run so the trigger writes a daily aggregate.
    sqlite.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'run-1'").run();
    const snapshot = (await buildMonitorSnapshotBase(db, monitorId, options))!;
    const day = snapshot.uptime.days.find((entry) => entry.date === '2026-09-20')!;
    expect(day.uptimePercentage).toBe(50);
    expect(day.averageResponseMs).toBe(120);
  });

  it('reuses 89 closed days and queries only the live UTC day on warm cohort builds', async () => {
    const { sqlite, db } = makeDatabase();
    addCohortMember(sqlite, seedReportData(sqlite));
    const cold = await buildReportCohortData(db, options);
    expect(cold.closedDaysCache?.days['11111111-1111-4111-8111-111111111111']).toHaveLength(89);

    const queries: string[] = [];
    const trackedDb = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    } as typeof db;
    const warm = await buildReportCohortData(trackedDb, {
      ...options,
      now: new Date('2026-09-20T12:01:00.000Z'),
      closedDaysCache: cold.closedDaysCache!,
    });
    const dailyQueries = queries.filter((query) => query.includes('FROM monitor_daily_uptime'));
    expect(dailyQueries).toHaveLength(1);
    expect(dailyQueries[0]).toContain('day = ?');
    expect(dailyQueries[0]).not.toContain('day >= ?');
    expect(warm.closedDaysCache).toBeUndefined();
  });

  it('rereads the final closing-day value at rollover and evicts only the oldest day', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '11111111-1111-4111-8111-111111111111',
      isPublic: 1,
    });
    addCohortMember(sqlite, monitorId);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const oldest = new Date(today);
    oldest.setUTCDate(oldest.getUTCDate() - 89);
    const todayKey = today.toISOString().slice(0, 10);
    const oldestKey = oldest.toISOString().slice(0, 10);
    sqlite
      .prepare(
        `INSERT INTO monitor_daily_uptime
          (monitor_id, day, uptime_percentage, weight, received_count, success_count)
         VALUES (?, ?, 100, 1, 1, 1)`,
      )
      .run(monitorId, oldestKey);
    const buildOptions = { ...options, now: new Date(today.getTime() + 12 * 3_600_000) };
    const cold = await buildReportCohortData(db, buildOptions);

    // This is still the live UTC day, so changing it does not touch the closed
    // history revision. The rollover must explicitly reread it before caching.
    sqlite
      .prepare(
        `INSERT INTO monitor_daily_uptime
          (monitor_id, day, uptime_percentage, average_response_ms, weight,
           received_count, success_count)
         VALUES (?, ?, 50, 25, 2, 2, 1)`,
      )
      .run(monitorId, todayKey);
    const queries: string[] = [];
    const rangeBinds: unknown[][] = [];
    const trackedDb = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        const statement = db.prepare(query);
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === 'bind' && query.includes('day >= ? AND day <= ?')) {
              return (...values: unknown[]) => {
                rangeBinds.push(values);
                return target.bind(...values);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
      },
    } as typeof db;
    const rolled = await buildReportCohortData(trackedDb, {
      ...buildOptions,
      now: new Date(tomorrow.getTime() + 30_000),
      closedDaysCache: cold.closedDaysCache!,
    });
    const dailyQueries = queries.filter((query) => query.includes('FROM monitor_daily_uptime'));
    expect(dailyQueries).toHaveLength(2);
    expect(dailyQueries.some((query) => query.includes('day >= ? AND day <= ?'))).toBe(true);
    expect(dailyQueries.some((query) => query.includes('day = ?'))).toBe(true);
    expect(rangeBinds).toEqual([[JSON.stringify([monitorId]), todayKey, todayKey]]);
    expect(rolled.closedDaysCache?.throughDay).toBe(todayKey);
    expect(rolled.closedDaysCache?.days[monitorId]?.at(-1)).toMatchObject({
      uptimePercentage: 50,
      averageResponseMs: 25,
      weight: 2,
    });
    const uptime = rolled.monitors.get(monitorId)!.uptime;
    expect(uptime.days[0]?.date).not.toBe(oldestKey);
    expect(uptime.days.at(-2)).toMatchObject({ date: todayKey, uptimePercentage: 50 });
    expect(uptime.uptimePercentage).toBe(50);
  });

  it('invalidates closed history for backfills and deletes while retaining explicit empty days', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedReportData(sqlite);
    addCohortMember(sqlite, monitorId);
    const cold = await buildReportCohortData(db, options);
    sqlite
      .prepare(
        `INSERT INTO monitor_daily_uptime
          (monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count)
         VALUES (?, '2026-09-19', 25, 40, 4, 4, 1)`,
      )
      .run(monitorId);
    const backfilled = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: cold.closedDaysCache!,
    });
    expect(backfilled.closedDaysCache).toBeDefined();
    expect(backfilled.monitors.get(monitorId)?.uptime.days.at(-2)).toMatchObject({
      date: '2026-09-19',
      uptimePercentage: 25,
    });

    sqlite
      .prepare(
        `UPDATE monitor_daily_uptime SET uptime_percentage = 75, success_count = 3
         WHERE monitor_id = ? AND day = '2026-09-19'`,
      )
      .run(monitorId);
    const updated = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: backfilled.closedDaysCache!,
    });
    expect(updated.closedDaysCache).toBeDefined();
    expect(updated.monitors.get(monitorId)?.uptime.days.at(-2)?.uptimePercentage).toBe(75);

    sqlite
      .prepare("DELETE FROM monitor_daily_uptime WHERE monitor_id = ? AND day = '2026-09-19'")
      .run(monitorId);
    const deleted = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: updated.closedDaysCache!,
    });
    expect(deleted.monitors.get(monitorId)?.uptime.days.at(-2)?.uptimePercentage).toBeNull();
    expect(deleted.closedDaysCache?.days[monitorId]?.at(-1)).toBeNull();

    const warmQueries: string[] = [];
    const trackedDb = {
      ...db,
      prepare(query: string) {
        warmQueries.push(query);
        return db.prepare(query);
      },
    } as typeof db;
    await buildReportCohortData(trackedDb, {
      ...options,
      closedDaysCache: deleted.closedDaysCache!,
    });
    expect(warmQueries.filter((query) => query.includes('CROSS JOIN check_runs'))).toHaveLength(0);
  });

  it('cold rebuilds malformed caches and monitor-set changes', async () => {
    const { sqlite, db } = makeDatabase();
    addCohortMember(sqlite, seedReportData(sqlite));
    const cold = await buildReportCohortData(db, options);
    const malformed = {
      ...cold.closedDaysCache!,
      days: { [cold.closedDaysCache!.monitorIds[0]!]: [null] },
    };
    const rebuilt = await buildReportCohortData(db, { ...options, closedDaysCache: malformed });
    expect(rebuilt.closedDaysCache?.days[rebuilt.closedDaysCache.monitorIds[0]!]).toHaveLength(89);

    addCohortMember(
      sqlite,
      seedMonitor(sqlite, { id: '22222222-2222-4222-8222-222222222222', isPublic: 1 }),
      1,
    );
    const added = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: rebuilt.closedDaysCache!,
    });
    expect(added.closedDaysCache?.monitorIds).toHaveLength(2);
    sqlite.prepare("DELETE FROM monitors WHERE id = '22222222-2222-4222-8222-222222222222'").run();
    const removed = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: added.closedDaysCache!,
    });
    expect(removed.closedDaysCache?.monitorIds).toHaveLength(1);
  });
});

describe('recovery progression', () => {
  function addRun(
    sqlite: ReturnType<typeof makeDatabase>['sqlite'],
    monitorId: string,
    index: number,
    success: boolean,
  ) {
    const window = new Date(Date.parse('2026-09-20T11:56:00.000Z') + index * 60_000).toISOString();
    seedRound(sqlite, {
      id: `run-${index}`,
      monitorId,
      windowStartedAt: window,
      status: 'complete',
      expectedRegions: ['us-east', 'us-west'],
    });
    seedObservation(sqlite, {
      checkRunId: `run-${index}`,
      monitorId,
      regionId: 'us-west',
      scheduledWindow: window,
      success,
      startedAt: new Date(Date.parse(window) + 5_000).toISOString(),
      completedAt: new Date(Date.parse(window) + 5_500).toISOString(),
    });
    seedObservation(sqlite, {
      checkRunId: `run-${index}`,
      monitorId,
      regionId: 'us-east',
      scheduledWindow: window,
      success: true,
      startedAt: new Date(Date.parse(window) + 6_000).toISOString(),
      completedAt: new Date(Date.parse(window) + 6_500).toISOString(),
    });
  }

  it('reports recovering after two consecutive regional successes', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '11111111-1111-4111-8111-111111111111',
      isPublic: 1,
      publicSlug: 'recovering',
      regions: ['us-east', 'us-west'],
    });
    addRun(sqlite, monitorId, 0, false);
    addRun(sqlite, monitorId, 1, true);
    addRun(sqlite, monitorId, 2, true);
    const snapshot = (await buildMonitorSnapshotBase(db, monitorId, options))!;
    expect(snapshot.uptime.recoveryStatus).toBe('recovering');
  });

  it('reports up after five consecutive regional successes', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '11111111-1111-4111-8111-111111111112',
      isPublic: 1,
      publicSlug: 'recovered',
      regions: ['us-east', 'us-west'],
    });
    addRun(sqlite, monitorId, 0, false);
    for (let index = 1; index <= 5; index += 1) addRun(sqlite, monitorId, index, true);
    // A pending newer failure is not recovery evidence, and a region that was
    // removed after failing still retains its recovery progression.
    const pendingWindow = '2026-09-20T12:02:00.000Z';
    seedRound(sqlite, {
      id: 'pending-run',
      monitorId,
      windowStartedAt: pendingWindow,
      status: 'pending',
      expectedRegions: ['us-west'],
    });
    seedObservation(sqlite, {
      checkRunId: 'pending-run',
      monitorId,
      regionId: 'us-west',
      scheduledWindow: pendingWindow,
      success: false,
      startedAt: new Date(Date.parse(pendingWindow) + 5_000).toISOString(),
    });
    sqlite
      .prepare("DELETE FROM monitor_regions WHERE monitor_id = ? AND region_id = 'us-west'")
      .run(monitorId);
    const snapshot = (await buildMonitorSnapshotBase(db, monitorId, options))!;
    expect(snapshot.uptime.recoveryStatus).toBe('up');
  });

  it('keeps both recovery lookups on bounded indexes', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '11111111-1111-4111-8111-111111111113',
      isPublic: 1,
      publicSlug: 'recovery-plan',
      regions: ['us-east', 'us-west'],
    });
    addRun(sqlite, monitorId, 0, false);
    addRun(sqlite, monitorId, 1, true);
    addRun(sqlite, monitorId, 2, true);

    const queries: string[] = [];
    const trackedDb = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    } as typeof db;
    await buildMonitorSnapshotBase(trackedDb, monitorId, options);

    const failureQuery = queries.find((query) => query.includes('candidate_regions'))!;
    const recentQuery = queries.find((query) => query.includes('SELECT o.success'))!;
    const failurePlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${failureQuery}`)
      .all(monitorId, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')
      .map((row) => String((row as { detail: string }).detail));
    const recentPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${recentQuery}`)
      .all('us-west', monitorId)
      .map((row) => String((row as { detail: string }).detail));

    expect(failurePlan).toContainEqual(
      expect.stringContaining('observations_failed_run_region_idx'),
    );
    expect(recentPlan).toContainEqual(expect.stringContaining('check_runs_monitor_time_idx'));
    expect(recentPlan).toContainEqual(expect.stringContaining('sqlite_autoindex_observations_3'));
    expect(recentPlan).not.toContainEqual(expect.stringContaining('TEMP B-TREE'));
  });
});
