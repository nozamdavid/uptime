import { describe, expect, it } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';
import { buildMonitorSnapshotBase, buildReportCohortData } from './reports.js';
import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { parseReportEnv } from './env.js';
import { publishDueReports, reportCohortIndexKey } from './publisher.js';
import { FakeR2 } from './testing-r2.js';
import { seedMonitor, seedObservation, seedRound, useTenantDatabase } from './testing-postgres.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const options = { now, staleAfterSeconds: 180 };

async function reportData(db: Database) {
  const id = await seedMonitor(db, {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Public status',
    url: 'https://status.example.test/health',
    isPublic: 1,
    publicSlug: 'public-status',
    intervalSeconds: 300,
    regions: ['us-east', 'us-west'],
    updatedAt: '2026-08-30T09:00:00.000Z',
  });
  await db.query(`DELETE FROM ${db.table('badges')} WHERE id=$1`, ['b1']);
  await db.query(`INSERT INTO ${db.table('badges')} (id,name,color) VALUES ($1,$2,$3)`, [
    'b1',
    'Core',
    '#112233',
  ]);
  await db.query(`UPDATE ${db.table('monitors')} SET badge_id=$1 WHERE id=$2`, ['b1', id]);
  await seedRound(db, {
    id: 'run-1',
    monitorId: id,
    windowStartedAt: '2026-09-20T11:59:00.000Z',
    status: 'complete',
    expectedRegions: ['us-east', 'us-west'],
    expectedRegionCount: 2,
    timeoutMs: 1000,
    deadlineAt: '2026-09-20T11:59:16.000Z',
  });
  await seedObservation(db, {
    checkRunId: 'run-1',
    monitorId: id,
    regionId: 'us-east',
    scheduledWindow: '2026-09-20T11:59:00.000Z',
    success: true,
    responseMs: 120,
    startedAt: '2026-09-20T11:59:05.000Z',
  });
  await seedObservation(db, {
    checkRunId: 'run-1',
    monitorId: id,
    regionId: 'us-west',
    scheduledWindow: '2026-09-20T11:59:00.000Z',
    success: false,
    errorCode: 'timeout',
    startedAt: '2026-09-20T11:59:06.000Z',
  });
  return id;
}
async function page(db: Database, monitorId: string) {
  await db.query(
    `INSERT INTO ${db.table('status_pages')} (id,title,public_slug,font_family) VALUES ('p1','Acme','acme','poppins')`,
  );
  await db.query(
    `INSERT INTO ${db.table('status_page_groups')} (id,status_page_id,title,position) VALUES ('g1','p1','Core',0)`,
  );
  await db.query(
    `INSERT INTO ${db.table('status_page_monitors')} (status_page_id,group_id,monitor_id,position) VALUES ('p1','g1',$1,0)`,
    [monitorId],
  );
}
function tracked(db: Database, queries: string[]): Database {
  return {
    schema: db.schema,
    table: (name) => db.table(name),
    query: async (sql, values) => {
      queries.push(sql);
      return db.query(sql, values);
    },
    transaction: (cb) => db.transaction((tx) => cb(tracked(tx, queries))),
  };
}
describe('coordinator PostgreSQL report snapshots', () => {
  const fixture = useTenantDatabase();
  it('matches the frontend contract and reports degraded status', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    const s = (await buildFullHistoryMonitorSnapshot(db, id, options))!;
    expect(s.schemaVersion).toBe('1');
    expect(s.generatedAt).toBe(now.toISOString());
    expect(s.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
    expect(s.staleAfterSeconds).toBe(180);
    expect(s.summary.monitor).toMatchObject({
      id,
      publicSlug: 'public-status',
      regionIds: ['us-east', 'us-west'],
    });
    expect(s.summary.monitor.badge).toEqual({ id: 'b1', name: 'Core', color: '#112233' });
    expect(s.summary.status).toBe('degraded');
    expect(s.summary.latestByRegion['us-east']).toMatchObject({ success: true, responseMs: 120 });
    expect(s.summary.latestByRegion['us-west']).toMatchObject({ success: false, responseMs: null });
    expect(s.summary.targetChecksPerDay).toBe(2 * (86_400 / 300));
    expect(s.latencyByRange?.['24h']).toBeDefined();
    expect(s.latency.stats.map((x) => x.regionId)).toEqual(['us-east', 'us-west']);
    expect(s.latency.stats).toEqual([
      { regionId: 'us-east', sampleCount: 1, successCount: 1, p50Ms: 120, p95Ms: 120, p99Ms: 120 },
      {
        regionId: 'us-west',
        sampleCount: 1,
        successCount: 0,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
    ]);
    expect(s.latency.aggregateStats).toEqual({
      averageResponseMs: 120,
      maximumResponseMs: 120,
      maximumResponseRegionId: 'us-east',
      minimumResponseMs: 120,
    });
    expect(s.latency.aggregatePoints).toEqual([
      { observedAt: '2026-09-20T11:55:00.000Z', responseMs: 120, success: false },
    ]);
    const json = JSON.stringify(s);
    expect(json).not.toContain('outageThreshold');
    expect(json).not.toContain('notificationServiceIds');
    expect(json).not.toContain('dnsDiagnosticsEnabled');
  });
  it('returns null for a deleted monitor so publication can be removed', async () => {
    expect(await buildMonitorSnapshotBase(fixture().db, 'missing', options)).toBeNull();
  });
  it('reports unknown when an expected region is missing from the latest round', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await db.query(
      `DELETE FROM ${db.table('observations')} WHERE check_run_id=$1 AND region_id=$2`,
      ['run-1', 'us-west'],
    );
    await db.query(`UPDATE ${db.table('check_runs')} SET status='partial' WHERE id=$1`, ['run-1']);
    const s = (await buildMonitorSnapshotBase(db, id, options))!;
    expect(s.summary.status).toBe('unknown');
    expect(s.summary.latestByRegion['us-east']?.success).toBe(true);
    expect(s.summary.latestByRegion['us-west']).toBeNull();
  });
  it('reports imported partial rounds unknown when their region list is incomplete', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await db.query(
      `DELETE FROM ${db.table('observations')} WHERE check_run_id=$1 AND region_id=$2`,
      ['run-1', 'us-west'],
    );
    await db.query(
      `UPDATE ${db.table('check_runs')} SET status='partial',expected_regions=$1,expected_region_count=2 WHERE id=$2`,
      ['["us-east"]', 'run-1'],
    );
    expect((await buildMonitorSnapshotBase(db, id, options))!.summary.status).toBe('unknown');
  });
  it('does not renew old healthy regional evidence when publishing a fresh report', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await db.query(
      `UPDATE ${db.table('observations')} SET success=1,status='success',error_code=NULL WHERE check_run_id=$1`,
      ['run-1'],
    );
    await page(db, id);
    const build = (n: number) =>
      buildReportCohortData(db, { ...options, now: new Date(now.getTime() + n * 1000) });
    expect(
      (await (await build(400)).statusPages.get('p1'))!.statusPage.groups[0]!.monitors[0]!.status,
    ).toBe('up');
    const stale = (await build(427)).statusPages.get('p1')!;
    expect(stale.generatedAt).toBe('2026-09-20T12:07:07.000Z');
    expect(stale.statusPage.groups[0]!.monitors[0]!.status).toBe('unknown');
    expect(
      (await buildMonitorSnapshotBase(db, id, {
        ...options,
        now: new Date('2026-09-20T12:07:07.000Z'),
      }))!.summary.status,
    ).toBe('unknown');
    await db.query(`UPDATE ${db.table('observations')} SET started_at=$1 WHERE region_id=$2`, [
      '2026-09-20T12:07:06.000Z',
      'us-east',
    ]);
    const mixed = (await build(427)).statusPages.get('p1')!;
    expect(mixed.latestObservationAt).toBe('2026-09-20T12:07:06.000Z');
    expect(mixed.statusPage.groups[0]!.monitors[0]!.status).toBe('unknown');
  });
  it('groups monitors into the public response shape', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await page(db, id);
    const s = (await buildReportCohortData(db, options)).statusPages.get('p1')!;
    expect(s.statusPage).toMatchObject({
      id: 'p1', title: 'Acme', publicSlug: 'acme', fontFamily: 'poppins',
    });
    const g = s.statusPage.groups[0]!;
    expect(g).toMatchObject({ id: 'g1', title: 'Core', width: 'full', showBadges: true });
    expect(g.monitors[0]).toMatchObject({
      id,
      uptimePercentage: 50,
      status: 'down',
      configuredRegionCount: 2,
      affectedRegionIds: ['us-west'],
      recoveryStatus: 'down',
    });
    expect(g.monitors[0]!.days).toHaveLength(90);
    expect(s.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
  });
  it('builds the public status page index', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await page(db, id);
    await db.query(
      `INSERT INTO ${db.table('report_publications')} (report_key,kind,status_page_id,object_key,schema_version,latest_observation_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        'status-page:p1',
        'status-page',
        'p1',
        'public/status-pages/acme.json',
        '1',
        '2026-09-20T11:59:06.000Z',
        'complete',
      ],
    );
    await db.query(
      `INSERT INTO ${db.table('report_publications')} (report_key,kind,object_key,schema_version,latest_observation_at,status) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        'status-page:deleted',
        'status-page',
        'public/status-pages/deleted.json',
        '1',
        '2026-09-20T12:00:00.000Z',
        'complete',
      ],
    );
    const r = new FakeR2();
    await publishDueReports(parseReportEnv({ DB: db, REPORTS: r }), now, console);
    const index = JSON.parse(r.store.get(reportCohortIndexKey(String(now.getTime())))!.body);
    expect(index.statusPages).toEqual([{
      id: 'p1', title: 'Acme', publicSlug: 'acme', fontFamily: 'poppins',
    }]);
    expect(index.schemaVersion).toBe('1');
    expect(index.latestObservationAt).toBe('2026-09-20T11:59:06.000Z');
  });
  it('uses current incomplete-round evidence instead of historical uptime for status', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await db.query(
      `DELETE FROM ${db.table('observations')} WHERE check_run_id=$1 AND region_id=$2`,
      ['run-1', 'us-west'],
    );
    await db.query(`UPDATE ${db.table('check_runs')} SET status='partial' WHERE id=$1`, ['run-1']);
    await page(db, id);
    expect(
      (await buildReportCohortData(db, options)).statusPages.get('p1')!.statusPage.groups[0]!
        .monitors[0]!.status,
    ).toBe('unknown');
  });
  async function cohort(db: Database, id: string, position = 0) {
    await db.query(
      `INSERT INTO ${db.table('status_pages')} (id,title) VALUES ('cohort','Cohort') ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO ${db.table('status_page_groups')} (id,status_page_id,title,position) VALUES ('cohort-group','cohort','Core',0) ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO ${db.table('status_page_monitors')} (status_page_id,group_id,monitor_id,position) VALUES ('cohort','cohort-group',$1,$2)`,
      [id, position],
    );
  }
  it('counts only received observations and weights by exact counts', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await db.query(
      `UPDATE ${db.table('check_runs')} SET status='complete',finalized_at=$1,completed_at=$1 WHERE id=$2`,
      ['2026-09-20T12:00:00.000Z', 'run-1'],
    );
    const day = (await buildMonitorSnapshotBase(db, id, options))!.uptime.days.find(
      (x) => x.date === '2026-09-20',
    )!;
    expect(day.uptimePercentage).toBe(50);
    expect(day.averageResponseMs).toBe(120);
  });
  it('reuses 89 closed days and queries only the live UTC day on warm cohort builds', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await cohort(db, id);
    const cold = await buildReportCohortData(db, options);
    expect(cold.closedDaysCache?.days[id]).toHaveLength(89);
    const queries: string[] = [];
    const warm = await buildReportCohortData(tracked(db, queries), {
      ...options,
      now: new Date('2026-09-20T12:01:00.000Z'),
      closedDaysCache: cold.closedDaysCache!,
    });
    const q = queries.filter(
      (x) => x.includes('SELECT monitor_id') && x.includes('monitor_daily_uptime'),
    );
    expect(q[0]).toContain('day = $');
    expect(q[0]).not.toContain('day >= $');
    expect(warm.closedDaysCache).toBeUndefined();
  });
  it('rereads the final closing-day value at rollover and evicts only the oldest day', async () => {
    const db = fixture().db;
    const id = await seedMonitor(db, { id: '11111111-1111-4111-8111-111111111111', isPublic: 1 });
    await cohort(db, id);
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const oldest = new Date(today);
    oldest.setUTCDate(oldest.getUTCDate() - 89);
    const day = today.toISOString().slice(0, 10);
    const old = oldest.toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO ${db.table('monitor_daily_uptime')} (monitor_id,day,uptime_percentage,weight,received_count,success_count) VALUES ($1,$2,100,1,1,1)`,
      [id, old],
    );
    const build = { ...options, now: new Date(today.getTime() + 12 * 3_600_000) };
    const cold = await buildReportCohortData(db, build);
    await db.query(
      `INSERT INTO ${db.table('monitor_daily_uptime')} (monitor_id,day,uptime_percentage,average_response_ms,weight,received_count,success_count) VALUES ($1,$2,50,25,2,2,1)`,
      [id, day],
    );
    const queries: string[] = [];
    const rolled = await buildReportCohortData(tracked(db, queries), {
      ...build,
      now: new Date(tomorrow.getTime() + 30_000),
      closedDaysCache: cold.closedDaysCache!,
    });
    const q = queries.filter(
      (x) => x.includes('SELECT monitor_id') && x.includes('monitor_daily_uptime'),
    );
    expect(q).toHaveLength(2);
    expect(q.some((x) => x.includes('day >= $'))).toBe(true);
    expect(q.some((x) => x.includes('day = $'))).toBe(true);
    expect(rolled.closedDaysCache?.throughDay).toBe(day);
    expect(rolled.closedDaysCache?.days[id]?.at(-1)).toMatchObject({
      uptimePercentage: 50,
      averageResponseMs: 25,
      weight: 2,
    });
    const u = rolled.monitors.get(id)!.uptime;
    expect(u.days[0]?.date).not.toBe(old);
    expect(u.days.at(-2)).toMatchObject({ date: day, uptimePercentage: 50 });
    expect(u.uptimePercentage).toBe(50);
  });
  it('invalidates closed history for backfills and deletes while retaining explicit empty days', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await cohort(db, id);
    const cold = await buildReportCohortData(db, options);
    await db.query(
      `INSERT INTO ${db.table('monitor_daily_uptime')} (monitor_id,day,uptime_percentage,average_response_ms,weight,received_count,success_count) VALUES ($1,'2026-09-19',25,40,4,4,1)`,
      [id],
    );
    const back = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: cold.closedDaysCache!,
    });
    expect(back.closedDaysCache).toBeDefined();
    expect(back.monitors.get(id)?.uptime.days.at(-2)).toMatchObject({
      date: '2026-09-19',
      uptimePercentage: 25,
    });
    await db.query(
      `UPDATE ${db.table('monitor_daily_uptime')} SET uptime_percentage=75,success_count=3 WHERE monitor_id=$1 AND day='2026-09-19'`,
      [id],
    );
    const updated = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: back.closedDaysCache!,
    });
    expect(updated.monitors.get(id)?.uptime.days.at(-2)?.uptimePercentage).toBe(75);
    await db.query(
      `DELETE FROM ${db.table('monitor_daily_uptime')} WHERE monitor_id=$1 AND day='2026-09-19'`,
      [id],
    );
    const deleted = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: updated.closedDaysCache!,
    });
    expect(deleted.monitors.get(id)?.uptime.days.at(-2)?.uptimePercentage).toBeNull();
    expect(deleted.closedDaysCache?.days[id]?.at(-1)).toBeNull();
    const queries: string[] = [];
    await buildReportCohortData(tracked(db, queries), {
      ...options,
      closedDaysCache: deleted.closedDaysCache!,
    });
    expect(queries.filter((x) => x.includes('CROSS JOIN check_runs'))).toHaveLength(0);
  });
  it('cold rebuilds malformed caches and monitor-set changes', async () => {
    const db = fixture().db;
    const id = await reportData(db);
    await cohort(db, id);
    const cold = await buildReportCohortData(db, options);
    const malformed = { ...cold.closedDaysCache!, days: { [id]: [null] } };
    const rebuilt = await buildReportCohortData(db, { ...options, closedDaysCache: malformed });
    expect(rebuilt.closedDaysCache?.days[id]).toHaveLength(89);
    const second = '22222222-2222-4222-8222-222222222222';
    const id2 = await seedMonitor(db, { id: second, isPublic: 1 });
    await cohort(db, id2, 1);
    const added = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: rebuilt.closedDaysCache!,
    });
    expect(added.closedDaysCache?.monitorIds).toHaveLength(2);
    await db.query(`DELETE FROM ${db.table('monitors')} WHERE id=$1`, [second]);
    const removed = await buildReportCohortData(db, {
      ...options,
      closedDaysCache: added.closedDaysCache!,
    });
    expect(removed.closedDaysCache?.monitorIds).toHaveLength(1);
  });
  async function run(db: Database, id: string, n: number, success: boolean) {
    const w = new Date(Date.parse('2026-09-20T11:56:00.000Z') + n * 60_000).toISOString();
    await seedRound(db, {
      id: `run-${n}`,
      monitorId: id,
      windowStartedAt: w,
      status: 'complete',
      expectedRegions: ['us-east', 'us-west'],
    });
    await seedObservation(db, {
      checkRunId: `run-${n}`,
      monitorId: id,
      regionId: 'us-west',
      scheduledWindow: w,
      success,
      startedAt: new Date(Date.parse(w) + 5000).toISOString(),
      completedAt: new Date(Date.parse(w) + 5500).toISOString(),
    });
    await seedObservation(db, {
      checkRunId: `run-${n}`,
      monitorId: id,
      regionId: 'us-east',
      scheduledWindow: w,
      success: true,
      startedAt: new Date(Date.parse(w) + 6000).toISOString(),
      completedAt: new Date(Date.parse(w) + 6500).toISOString(),
    });
  }
  it('reports recovering after two consecutive regional successes', async () => {
    const db = fixture().db;
    const id = await seedMonitor(db, {
      id: '11111111-1111-4111-8111-111111111111',
      isPublic: 1,
      regions: ['us-east', 'us-west'],
    });
    await run(db, id, 0, false);
    await run(db, id, 1, true);
    await run(db, id, 2, true);
    expect((await buildMonitorSnapshotBase(db, id, options))!.uptime.recoveryStatus).toBe(
      'recovering',
    );
  });
  it('reports up after five consecutive regional successes', async () => {
    const db = fixture().db;
    const id = await seedMonitor(db, {
      id: '11111111-1111-4111-8111-111111111112',
      isPublic: 1,
      regions: ['us-east', 'us-west'],
    });
    await run(db, id, 0, false);
    for (let n = 1; n <= 5; n += 1) await run(db, id, n, true);
    await seedRound(db, {
      id: 'pending-run',
      monitorId: id,
      windowStartedAt: '2026-09-20T12:02:00.000Z',
      status: 'pending',
      expectedRegions: ['us-west'],
    });
    await seedObservation(db, {
      checkRunId: 'pending-run',
      monitorId: id,
      regionId: 'us-west',
      scheduledWindow: '2026-09-20T12:02:00.000Z',
      success: false,
      startedAt: '2026-09-20T12:02:05.000Z',
    });
    await db.query(
      `DELETE FROM ${db.table('monitor_regions')} WHERE monitor_id=$1 AND region_id='us-west'`,
      [id],
    );
    expect((await buildMonitorSnapshotBase(db, id, options))!.uptime.recoveryStatus).toBe('up');
  });
  it('keeps both recovery lookups on bounded indexes', async () => {
    const db = fixture().db;
    const id = await seedMonitor(db, {
      id: '11111111-1111-4111-8111-111111111113',
      isPublic: 1,
      regions: ['us-east', 'us-west'],
    });
    await run(db, id, 0, false);
    await run(db, id, 1, true);
    await run(db, id, 2, true);
    await db.query('SET enable_seqscan=off');
    const failed = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT candidate.region_id FROM (VALUES ('us-east'),('us-west')) candidate(region_id) WHERE EXISTS (SELECT 1 FROM ${db.table('observations')} o JOIN ${db.table('check_runs')} cr ON cr.id=o.check_run_id WHERE o.monitor_id=$1 AND o.region_id=candidate.region_id AND o.success=0 AND o.scheduled_window >= $2 AND cr.monitor_id=o.monitor_id AND cr.status IN ('complete','partial') AND cr.window_started_at >= $3 LIMIT 1)`,
      [id, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'],
    );
    const recent = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT o.success FROM ${db.table('check_runs')} cr JOIN ${db.table('observations')} o ON o.check_run_id=cr.id AND o.region_id=$1 WHERE cr.monitor_id=$2 AND cr.status IN ('complete','partial') ORDER BY cr.window_started_at DESC LIMIT 5`,
      ['us-west', id],
    );
    const text = (x: { 'QUERY PLAN': string }[]) => x.map((r) => r['QUERY PLAN']).join('\n');
    expect(text(failed.rows)).toContain('observations_failed_run_region_idx');
    expect(text(recent.rows)).toContain('check_runs_monitor_time_idx');
    expect(text(recent.rows)).toContain('observations_run_region_unique');
    expect(text(recent.rows)).not.toContain('Sort');
  });
});
