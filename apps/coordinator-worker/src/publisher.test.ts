import { describe, expect, it, vi } from 'vitest';
import type { ReportConfig } from './env.js';
import {
  desiredPublications,
  monitorObjectKey,
  publishDueReports,
  reportCohortIndexKey,
  reportCohortPointerKey,
  reportCohortStatusPageKey,
  reportCohortUptimeCacheKey,
  statusPageIndexObjectKey,
  statusPageObjectKey,
} from './publisher.js';
import type { StatusPageReportSnapshot } from './report-types.js';
import { FakeR2 } from './testing-r2.js';
import { count, makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';
import type { MonitorRefreshParams } from './on-demand-monitor.js';
import { runReportJob } from './report-job.js';

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

function seedPage(sqlite: ReturnType<typeof makeDatabase>['sqlite'], size = 1) {
  sqlite
    .prepare(
      "INSERT INTO status_pages (id, title, public_slug) VALUES ('page', 'Services', 'services')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES ('group', 'page', 'Core', 0)",
    )
    .run();
  const ids: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const id = seedMonitor(sqlite, {
      id: `member-${index}`,
      regions: ['us-east'],
      isPublic: 1,
      publicSlug: `member-${index}`,
    });
    ids.push(id);
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('page', 'group', ?, ?)",
      )
      .run(id, index);
    seedRound(sqlite, {
      id: `run-${index}`,
      monitorId: id,
      windowStartedAt: now.toISOString(),
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    seedObservation(sqlite, {
      id: `observation-${index}`,
      checkRunId: `run-${index}`,
      monitorId: id,
      regionId: 'us-east',
      scheduledWindow: now.toISOString(),
      success: index % 2 === 0,
      responseMs: 100 + index,
    });
  }
  return ids;
}

function pointer(reports: FakeR2) {
  return JSON.parse(reports.store.get(reportCohortPointerKey)!.body) as {
    generation: string;
    previousGenerations: string[];
  };
}

function page(reports: FakeR2): StatusPageReportSnapshot {
  return JSON.parse(
    reports.store.get(reportCohortStatusPageKey(pointer(reports).generation, 'services'))!.body,
  );
}

describe('scheduled status-page publication', () => {
  it('starts current incidents once across pages and excludes healthy, recovered, disabled, and unknown members', async () => {
    const { sqlite, db } = makeDatabase();
    const ids = seedPage(sqlite, 8);
    // Two successful probes still display recovering; five display up despite
    // historical affected regions. Eligibility follows that published display.
    for (const [index, successes] of [
      [1, 2],
      [3, 5],
    ] as const) {
      for (let ordinal = 1; ordinal <= successes; ordinal += 1) {
        const window = new Date(now.getTime() + ordinal * 60_000).toISOString();
        seedRound(sqlite, {
          id: `recovery-${index}-${ordinal}`,
          monitorId: ids[index]!,
          windowStartedAt: window,
          status: 'complete',
        });
        seedObservation(sqlite, {
          checkRunId: `recovery-${index}-${ordinal}`,
          monitorId: ids[index]!,
          regionId: 'us-east',
          scheduledWindow: window,
          success: true,
        });
      }
    }
    sqlite.prepare('UPDATE monitors SET enabled = 0 WHERE id = ?').run(ids[5]!);
    sqlite.prepare('DELETE FROM observations WHERE monitor_id = ?').run(ids[7]!);
    sqlite
      .prepare('INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, ?)')
      .run(ids[6]!, 'us-west');
    seedObservation(sqlite, {
      checkRunId: 'run-6',
      monitorId: ids[6]!,
      regionId: 'us-west',
      scheduledWindow: now.toISOString(),
      success: false,
    });
    sqlite.prepare("INSERT INTO status_pages (id, title) VALUES ('second', 'Second')").run();
    sqlite
      .prepare(
        "INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES ('second-group', 'second', 'Shared', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES ('second', 'second-group', ?, 0)",
      )
      .run(ids[1]!);
    const create = vi.fn(async (_options: { id: string; params: MonitorRefreshParams }) => ({}));
    const workflow = { create } as unknown as Workflow<MonitorRefreshParams>;
    const reports = new FakeR2();
    const settings = { ...config(db, reports), monitorRefresh: workflow };
    const publicationTime = new Date(now.getTime() + 6 * 60_000);
    expect(await publishDueReports(settings, publicationTime, log)).toMatchObject({
      published: 3,
      failed: 0,
    });
    const members = page(reports).statusPage.groups[0]!.monitors;
    expect(members[1]).toMatchObject({ status: 'up', recoveryStatus: 'recovering' });
    expect(members[3]).toMatchObject({ status: 'up', recoveryStatus: 'up' });
    expect(members[3]!.days.at(-1)!.uptimePercentage).toBeLessThan(100);
    expect(members[7]).toMatchObject({ status: 'unknown', recoveryStatus: null });
    expect(members[6]).toMatchObject({ status: 'down', recoveryStatus: 'down' });
    expect(create.mock.calls.map(([options]) => options.params.monitorId)).toEqual([
      ids[1],
      ids[6],
    ]);
    expect(count(sqlite, 'monitor_report_refresh')).toBe(2);
    expect([...reports.store.keys()].some((key) => key.startsWith('public/monitor-refresh/'))).toBe(
      false,
    );
    await publishDueReports(settings, new Date(publicationTime.getTime() + 60_000), log);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not start incident work when the conditional cohort commit fails', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite, 2);
    const create = vi.fn();
    const reports = new FakeR2();
    const put = reports.put.bind(reports);
    vi.spyOn(reports, 'put').mockImplementation((key, value, options) =>
      key === reportCohortPointerKey ? Promise.resolve(null) : put(key, value, options),
    );
    await expect(
      publishDueReports(
        {
          ...config(db, reports),
          monitorRefresh: { create } as unknown as Workflow<MonitorRefreshParams>,
        },
        now,
        log,
      ),
    ).rejects.toThrow('Report cohort pointer changed');
    expect(create).not.toHaveBeenCalled();
    expect(count(sqlite, 'monitor_report_refresh')).toBe(0);
  });

  it('preserves successful publication during a Workflow service outage and retries startup', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite, 2);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Workflow unavailable'))
      .mockResolvedValue({});
    const get = vi.fn().mockRejectedValue(new Error('instance absent'));
    const reports = new FakeR2();
    const settings = {
      ...config(db, reports),
      monitorRefresh: { create, get } as unknown as Workflow<MonitorRefreshParams>,
    };
    expect(await publishDueReports(settings, now, log)).toMatchObject({
      published: 2,
      failed: 0,
    });
    const first = sqlite.prepare('SELECT token, phase FROM monitor_report_refresh').get() as {
      token: string;
      phase: string;
    };
    expect(first.phase).toBe('starting');
    expect(await publishDueReports(settings, new Date(now.getTime() + 60_000), log)).toMatchObject({
      published: 2,
      failed: 0,
    });
    expect(create.mock.calls[1]![0].id).toBe(first.token);
    expect(count(sqlite, 'monitor_report_refresh')).toBe(1);
  });

  it('keeps startup and required hourly work within the report job budget across many pages', async () => {
    const { sqlite, db } = makeDatabase();
    const ids = seedPage(sqlite, 106);
    for (let index = 0; index < 35; index += 1) {
      sqlite
        .prepare('INSERT INTO status_pages (id, title) VALUES (?, ?)')
        .run(`page-${index}`, `Page ${index}`);
      sqlite
        .prepare(
          'INSERT INTO status_page_groups (id, status_page_id, title, position) VALUES (?, ?, ?, 0)',
        )
        .run(`group-${index}`, `page-${index}`, 'Issues');
      sqlite
        .prepare(
          'INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position) VALUES (?, ?, ?, 0)',
        )
        .run(`page-${index}`, `group-${index}`, ids[index * 2 + 1]!);
    }
    sqlite
      .prepare(
        "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'budget-lease', '2099-01-01T00:00:00.000Z')",
      )
      .run();
    const create = vi.fn(async () => ({}));
    const reports = new FakeR2();
    const result = await runReportJob(
      {
        ...config(db, reports),
        monitorRefresh: { create } as unknown as Workflow<MonitorRefreshParams>,
      },
      { log, now: () => now, jobLeaseToken: 'budget-lease' },
    );
    expect(result).toMatchObject({ published: 37, failed: 0 });
    expect(create.mock.calls.length).toBeGreaterThan(0);
    expect(create.mock.calls.length).toBeLessThanOrEqual(20);
    expect(
      Object.values(result.queryWork).reduce((total, work) => total + work.statements, 0),
    ).toBeLessThanOrEqual(100);
    expect(result.queryWork['hourly-rollups']!.statements).toBeGreaterThan(0);
    expect([...reports.store.keys()].some((key) => key.startsWith('public/monitor-refresh/'))).toBe(
      false,
    );
  });

  it('publishes ninety pages without spending one D1 statement per page', async () => {
    const { sqlite, db } = makeDatabase();
    for (let index = 0; index < 90; index += 1)
      sqlite
        .prepare('INSERT INTO status_pages (id, title) VALUES (?, ?)')
        .run(`page-${index}`, `Page ${index}`);
    sqlite
      .prepare(
        "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')",
      )
      .run();
    const reports = new FakeR2();
    const result = await runReportJob(config(db, reports), {
      log,
      now: () => now,
      jobLeaseToken: 'lease',
    });
    expect(result).toMatchObject({ published: 91, failed: 0 });
    expect(reports.store.has(reportCohortPointerKey)).toBe(true);
    expect(result.queryWork.reports!.statements).toBeLessThan(30);
  });

  it('rechecks the job lease before committing even when publication finishes quickly', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    sqlite
      .prepare(
        "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')",
      )
      .run();
    const reports = new FakeR2();
    const put = reports.put.bind(reports);
    vi.spyOn(reports, 'put').mockImplementation(async (key, value, options) => {
      if (key === reportCohortIndexKey(String(now.getTime())))
        sqlite.prepare("UPDATE jobs SET lease_token = 'replacement' WHERE name = 'reports'").run();
      return put(key, value, options);
    });
    await expect(publishDueReports(config(db, reports), now, log, 'lease')).rejects.toThrow(
      'Report publication lease expired or changed',
    );
    expect(reports.store.has(reportCohortPointerKey)).toBe(false);
  });

  it('renews the lease during slow immutable page writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { sqlite, db } = makeDatabase();
      for (const id of ['first', 'second'])
        sqlite.prepare('INSERT INTO status_pages (id, title) VALUES (?, ?)').run(id, id);
      sqlite
        .prepare(
          "INSERT INTO jobs (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')",
        )
        .run();
      const reports = new FakeR2();
      const put = reports.put.bind(reports);
      vi.spyOn(reports, 'put').mockImplementation(async (key, value, options) => {
        vi.setSystemTime(Date.now() + 40_000);
        return put(key, value, options);
      });
      const result = await publishDueReports(config(db, reports), now, log, 'lease');
      expect(result).toMatchObject({ published: 3, failed: 0 });
      expect(reports.store.has(reportCohortPointerKey)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled pointer read and surfaces its failure', async () => {
    vi.useFakeTimers();
    try {
      const { db } = makeDatabase();
      const reports = new FakeR2();
      reports.get = () => new Promise<never>(() => undefined);
      const publication = publishDueReports(config(db, reports), now, log);
      const rejected = expect(publication).rejects.toThrow('Timed out reading report object');
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps legacy object keys and schedules only status pages and their index', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    seedMonitor(sqlite, { isPublic: 1, publicSlug: 'independent' });
    expect(monitorObjectKey('a/b')).toBe('public/monitors/a%2Fb.json');
    expect(statusPageObjectKey('a/b')).toBe('public/status-pages/a%2Fb.json');
    expect(statusPageIndexObjectKey).toBe('public/status-pages.json');
    expect((await desiredPublications(db)).map((item) => item.reportKey)).toEqual([
      'status-page:page',
      'index',
    ]);
  });

  it('publishes all 106 members with bounded queries and no scheduled monitor charts', async () => {
    const { sqlite, db } = makeDatabase();
    const ids = seedPage(sqlite, 106);
    for (let index = 0; index < 150; index += 1) seedMonitor(sqlite, { isPublic: 1 });
    const queries: string[] = [];
    const tracked = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    };
    const reports = new FakeR2();
    const writes: string[] = [];
    const put = reports.put.bind(reports);
    reports.put = async (key, value, options) => {
      writes.push(key);
      return put(key, value, options);
    };
    expect(await publishDueReports(config(tracked, reports), now, log)).toMatchObject({
      published: 2,
      failed: 0,
    });
    const members = page(reports).statusPage.groups[0]!.monitors;
    expect(members).toHaveLength(106);
    members.forEach((member, index) => {
      expect(member.id).toBe(ids[index]);
      expect(member.status).toBe(index % 2 === 0 ? 'up' : 'down');
      expect(member.days).toHaveLength(90);
      expect(member.days.at(-1)?.uptimePercentage).toBe(index % 2 === 0 ? 100 : 0);
    });
    expect(writes.filter((key) => key.startsWith('public/'))).toEqual([
      reportCohortStatusPageKey(pointer(reports).generation, 'services'),
      reportCohortIndexKey(pointer(reports).generation),
      reportCohortPointerKey,
    ]);
    expect(writes.some((key) => key.includes('samples') || key.includes('monitors-'))).toBe(false);
    expect(JSON.parse(reports.store.get(reportCohortUptimeCacheKey)!.body).monitorIds).toHaveLength(
      106,
    );
    expect(queries.length).toBeLessThan(30);
    expect(
      queries.some(
        (query) => query.includes('FROM observations') && query.includes('ORDER BY started_at'),
      ),
    ).toBe(false);
  });

  it('refreshes only live-day aggregates on warm idle publication without raw history or sample shards', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite, 106);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    const cache = reports.store.get(reportCohortUptimeCacheKey)!.etag;
    const queries: string[] = [];
    const reads: string[] = [];
    const get = reports.get.bind(reports);
    reports.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    const tracked = {
      ...db,
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    };
    await publishDueReports(config(tracked, reports), new Date(now.getTime() + 60_000), log);
    expect(reads).toEqual([reportCohortPointerKey, reportCohortUptimeCacheKey]);
    expect(queries.filter((query) => query.includes('FROM monitor_daily_uptime'))).toHaveLength(1);
    expect(queries.find((query) => query.includes('FROM monitor_daily_uptime'))).toContain(
      'day = ?',
    );
    const observationReads = queries.filter((query) => query.includes('FROM observations'));
    expect(observationReads).toHaveLength(2);
    // Recovery uses indexed latest-failure/live-day seeks and five recent probes,
    // rather than the raw history scan formerly used for each monitor chart.
    expect(observationReads.every((query) => query.includes('scheduled_window'))).toBe(true);
    expect(observationReads.some((query) => query.includes('started_at >= ?'))).toBe(false);
    expect(reports.store.get(reportCohortUptimeCacheKey)!.etag).toBe(cache);
    expect(queries.length).toBeLessThan(25);
  });

  it('refreshes the live day and invalidates closed days after a late correction', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    seedRound(sqlite, {
      id: 'late-run',
      monitorId: 'member-0',
      windowStartedAt: '2026-09-20T12:00:30.000Z',
      status: 'complete',
    });
    seedObservation(sqlite, {
      checkRunId: 'late-run',
      monitorId: 'member-0',
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T12:00:30.000Z',
      success: false,
    });
    await publishDueReports(config(db, reports), new Date(now.getTime() + 60_000), log);
    expect(page(reports).statusPage.groups[0]!.monitors[0]!.days.at(-1)?.uptimePercentage).toBe(50);
    const tomorrow = new Date('2026-09-21T00:01:00.000Z');
    await publishDueReports(config(db, reports), tomorrow, log);
    expect(page(reports).statusPage.groups[0]!.monitors[0]!.days.at(-2)?.uptimePercentage).toBe(50);
    const revision = JSON.parse(reports.store.get(reportCohortUptimeCacheKey)!.body).revision;
    seedRound(sqlite, {
      id: 'closed-late-run',
      monitorId: 'member-0',
      windowStartedAt: '2026-09-20T12:00:45.000Z',
      status: 'complete',
    });
    seedObservation(sqlite, {
      checkRunId: 'closed-late-run',
      monitorId: 'member-0',
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T12:00:45.000Z',
      success: false,
    });
    await publishDueReports(config(db, reports), new Date(tomorrow.getTime() + 60_000), log);
    expect(
      JSON.parse(reports.store.get(reportCohortUptimeCacheKey)!.body).revision,
    ).toBeGreaterThan(revision);
    expect(
      page(reports).statusPage.groups[0]!.monitors[0]!.days.at(-2)?.uptimePercentage,
    ).toBeCloseTo(100 / 3);
  });

  it('keeps the previous generation stable when a page write fails', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    const before = reports.store.get(reportCohortPointerKey)!.body;
    const put = reports.put.bind(reports);
    reports.put = async (key, value, options) => {
      if (key.includes('/status-pages/')) throw new Error('write failed');
      return put(key, value, options);
    };
    await expect(
      publishDueReports(config(db, reports), new Date(now.getTime() + 60_000), log),
    ).rejects.toThrow('write failed');
    expect(reports.store.get(reportCohortPointerKey)!.body).toBe(before);
    expect(page(reports).statusPage.groups[0]!.monitors).toHaveLength(1);
  });

  it('rejects a competing pointer commit', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    const put = reports.put.bind(reports);
    reports.put = async (key, value, options) => {
      if (key === reportCohortPointerKey) return null;
      return put(key, value, options);
    };
    await expect(
      publishDueReports(config(db, reports), new Date(now.getTime() + 60_000), log),
    ).rejects.toThrow('pointer changed');
    expect(pointer(reports).generation).toBe(String(now.getTime()));
  });

  it('discards an uncommitted generation when a page disappears during publication', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    const put = reports.put.bind(reports);
    reports.put = async (key, value, options) => {
      if (key.endsWith('/status-pages.json'))
        sqlite.prepare("DELETE FROM status_pages WHERE id = 'page'").run();
      return put(key, value, options);
    };
    const next = new Date(now.getTime() + 60_000);
    expect(await publishDueReports(config(db, reports), next, log)).toMatchObject({
      published: 0,
      skipped: 2,
    });
    expect(pointer(reports).generation).toBe(String(now.getTime()));
    expect(
      [...reports.store.keys()].some((key) => key.startsWith(`public/cohorts/${next.getTime()}/`)),
    ).toBe(false);
  });

  it('removes legacy objects and only one old orphan per successful publication', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    const legacy = monitorObjectKey('old');
    await reports.put(legacy, '{}');
    sqlite
      .prepare(
        "INSERT INTO report_publications (report_key, kind, object_key, schema_version) VALUES ('monitor:old', 'monitor', ?, '1')",
      )
      .run(legacy);
    const old = String(now.getTime() - 1_200_000);
    const recent = String(now.getTime() - 60_000);
    await reports.put(`public/cohorts/${old}/monitors-0.json`, '{}');
    await reports.put(`public/cohorts/${recent}/monitors-0.json`, '{}');
    await publishDueReports(config(db, reports), now, log);
    expect(reports.store.has(legacy)).toBe(false);
    expect(reports.store.has(`public/cohorts/${old}/monitors-0.json`)).toBe(false);
    expect(reports.store.has(`public/cohorts/${recent}/monitors-0.json`)).toBe(true);
    expect(count(sqlite, 'report_publications')).toBe(1);
  });

  it('retains only five committed generations', async () => {
    const { sqlite, db } = makeDatabase();
    seedPage(sqlite);
    const reports = new FakeR2();
    for (let tick = 0; tick < 6; tick += 1)
      await publishDueReports(config(db, reports), new Date(now.getTime() + tick * 60_000), log);
    expect(pointer(reports).previousGenerations).toHaveLength(4);
    expect(reports.store.has(reportCohortIndexKey(String(now.getTime())))).toBe(false);
  });
});
