import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';
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
import {
  count,
  first as pgFirst,
  seedMonitors,
  seedObservation,
  seedRound,
  useTenantDatabase,
} from './testing-postgres.js';
import type { MonitorRefreshParams } from './on-demand-monitor.js';
import { runReportJob } from './report-job.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const log = { warn: () => undefined, error: () => undefined };
const makeDatabase = useTenantDatabase();
vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

function config(db: Database, reports: FakeR2 | null): ReportConfig {
  return {
    db,
    reports,
    reportIntervalSeconds: 60,
    staleAfterSeconds: 180,
  };
}

async function execute(db: Database, query: string, params: readonly unknown[] = []) {
  return db.query(query, params);
}

async function seedMonitor(db: Database, seed: Parameters<typeof seedMonitors>[1][number]) {
  return (await seedMonitors(db, [seed]))[0]!;
}

function trackedDatabase(db: Database, queries: string[]): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(callback: (tx: Database) => Promise<T>) =>
          target.transaction((tx) => callback(trackedDatabase(tx, queries)));
      }
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (query: string, params?: readonly unknown[]) => {
        queries.push(query);
        return target.query(query, params);
      };
    },
  });
}

async function seedPage(db: Database, size = 1) {
  await execute(
    db,
    `INSERT INTO ${db.table('status_pages')} (id, title, public_slug) VALUES ('page', 'Services', 'services')`,
  );
  await execute(
    db,
    `INSERT INTO ${db.table('status_page_groups')} (id, status_page_id, title, position) VALUES ('group', 'page', 'Core', 0)`,
  );
  const ids: string[] = [];
  const seeds = Array.from({ length: size }, (_, index) => ({
    id: `member-${index}`,
    regions: ['us-east'] as const,
    isPublic: 1 as const,
    publicSlug: `member-${index}`,
  }));
  await seedMonitors(db, seeds);
  for (let index = 0; index < size; index += 1) {
    const id = seeds[index]!.id!;
    ids.push(id);
    await execute(
      db,
      `INSERT INTO ${db.table('status_page_monitors')} (status_page_id, group_id, monitor_id, position) VALUES ('page', 'group', $1, $2)`,
      [id, index],
    );
    await seedRound(db, {
      id: `run-${index}`,
      monitorId: id,
      windowStartedAt: now.toISOString(),
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
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
  it('publishes current incidents without starting monitor generation', async () => {
    const { db } = makeDatabase();
    const ids = await seedPage(db, 8);
    // Keep these incident fixtures current through the six-minute publication delay.
    await execute(db, `UPDATE ${db.table('monitors')} SET interval_seconds = 300`);
    // Two successful probes still display recovering; five display up despite
    // historical affected regions. Eligibility follows that published display.
    for (const [index, successes] of [
      [1, 2],
      [3, 5],
    ] as const) {
      for (let ordinal = 1; ordinal <= successes; ordinal += 1) {
        const window = new Date(now.getTime() + ordinal * 60_000).toISOString();
        await seedRound(db, {
          id: `recovery-${index}-${ordinal}`,
          monitorId: ids[index]!,
          windowStartedAt: window,
          status: 'complete',
        });
        await seedObservation(db, {
          checkRunId: `recovery-${index}-${ordinal}`,
          monitorId: ids[index]!,
          regionId: 'us-east',
          scheduledWindow: window,
          success: true,
        });
      }
    }
    await execute(db, `UPDATE ${db.table('monitors')} SET enabled = 0 WHERE id = $1`, [ids[5]!]);
    await execute(db, `DELETE FROM ${db.table('observations')} WHERE monitor_id = $1`, [ids[7]!]);
    await execute(
      db,
      `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id) VALUES ($1, $2)`,
      [ids[6]!, 'us-west'],
    );
    await seedObservation(db, {
      checkRunId: 'run-6',
      monitorId: ids[6]!,
      regionId: 'us-west',
      scheduledWindow: now.toISOString(),
      success: false,
    });
    await execute(
      db,
      `INSERT INTO ${db.table('status_pages')} (id, title) VALUES ('second', 'Second')`,
    );
    await execute(
      db,
      `INSERT INTO ${db.table('status_page_groups')} (id, status_page_id, title, position) VALUES ('second-group', 'second', 'Shared', 0)`,
    );
    await execute(
      db,
      `INSERT INTO ${db.table('status_page_monitors')} (status_page_id, group_id, monitor_id, position) VALUES ('second', 'second-group', $1, 0)`,
      [ids[1]!],
    );
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
    expect(create).not.toHaveBeenCalled();
    expect(await count(db, 'monitor_report_refresh')).toBe(0);
    expect([...reports.store.keys()].some((key) => key.startsWith('public/monitor-refresh/'))).toBe(
      false,
    );
    await publishDueReports(settings, new Date(publicationTime.getTime() + 60_000), log);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not start incident work when the conditional cohort commit fails', async () => {
    const { db } = makeDatabase();
    await seedPage(db, 2);
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
    expect(await count(db, 'monitor_report_refresh')).toBe(0);
  });

  it('publishes without contacting the retired monitor Workflow service', async () => {
    const { db } = makeDatabase();
    await seedPage(db, 2);
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
    expect(await publishDueReports(settings, new Date(now.getTime() + 60_000), log)).toMatchObject({
      published: 2,
      failed: 0,
    });
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await count(db, 'monitor_report_refresh')).toBe(0);
  });

  it('keeps startup and required hourly work within the report job budget across many pages', async () => {
    const { db } = makeDatabase();
    const ids = await seedPage(db, 106);
    for (let index = 0; index < 35; index += 1) {
      await execute(db, `INSERT INTO ${db.table('status_pages')} (id, title) VALUES ($1, $2)`, [
        `page-${index}`,
        `Page ${index}`,
      ]);
      await execute(
        db,
        `INSERT INTO ${db.table('status_page_groups')} (id, status_page_id, title, position) VALUES ($1, $2, $3, 0)`,
        [`group-${index}`, `page-${index}`, 'Issues'],
      );
      await execute(
        db,
        `INSERT INTO ${db.table('status_page_monitors')} (status_page_id, group_id, monitor_id, position) VALUES ($1, $2, $3, 0)`,
        [`page-${index}`, `group-${index}`, ids[index * 2 + 1]!],
      );
    }
    await execute(
      db,
      `INSERT INTO ${db.table('jobs')} (name, lease_token, lease_until) VALUES ('reports', 'budget-lease', '2099-01-01T00:00:00.000Z')`,
    );
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
    expect(create).not.toHaveBeenCalled();
    expect(
      Object.values(result.queryWork).reduce((total, work) => total + work.statements, 0),
    ).toBeLessThanOrEqual(100);
    expect(result.queryWork['hourly-rollups']!.statements).toBeGreaterThan(0);
    expect([...reports.store.keys()].some((key) => key.startsWith('public/monitor-refresh/'))).toBe(
      false,
    );
  });

  it('publishes ninety pages without spending one D1 statement per page', async () => {
    const { db } = makeDatabase();
    for (let index = 0; index < 90; index += 1)
      await execute(db, `INSERT INTO ${db.table('status_pages')} (id, title) VALUES ($1, $2)`, [
        `page-${index}`,
        `Page ${index}`,
      ]);
    await execute(
      db,
      `INSERT INTO ${db.table('jobs')} (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')`,
    );
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
    const { db } = makeDatabase();
    await seedPage(db);
    await execute(
      db,
      `INSERT INTO ${db.table('jobs')} (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')`,
    );
    const reports = new FakeR2();
    const put = reports.put.bind(reports);
    vi.spyOn(reports, 'put').mockImplementation(async (key, value, options) => {
      if (key === reportCohortIndexKey(String(now.getTime())))
        await execute(
          db,
          `UPDATE ${db.table('jobs')} SET lease_token = 'replacement' WHERE name = 'reports'`,
        );
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
      const { db } = makeDatabase();
      for (const id of ['first', 'second'])
        await execute(db, `INSERT INTO ${db.table('status_pages')} (id, title) VALUES ($1, $2)`, [
          id,
          id,
        ]);
      await execute(
        db,
        `INSERT INTO ${db.table('jobs')} (name, lease_token, lease_until) VALUES ('reports', 'lease', '2099-01-01T00:00:00.000Z')`,
      );
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
    const { db } = makeDatabase();
    const reports = new FakeR2();
    reports.get = () => new Promise<never>(() => undefined);
    await expect(publishDueReports(config(db, reports), now, log)).rejects.toThrow(
      'Timed out reading report object',
    );
  });

  it('keeps legacy object keys and schedules only status pages and their index', async () => {
    const { db } = makeDatabase();
    await seedPage(db);
    await seedMonitor(db, { isPublic: 1, publicSlug: 'independent' });
    expect(monitorObjectKey('a/b')).toBe('public/monitors/a%2Fb.json');
    expect(statusPageObjectKey('a/b')).toBe('public/status-pages/a%2Fb.json');
    expect(statusPageIndexObjectKey).toBe('public/status-pages.json');
    expect((await desiredPublications(db)).map((item) => item.reportKey)).toEqual([
      'status-page:page',
      'index',
    ]);
  });

  it('publishes all 106 members with bounded queries and no scheduled monitor charts', async () => {
    const { db } = makeDatabase();
    const ids = await seedPage(db, 106);
    await seedMonitors(
      db,
      Array.from({ length: 150 }, () => ({ isPublic: 1 as const })),
    );
    const queries: string[] = [];
    const tracked = trackedDatabase(db, queries);
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
        (query) =>
          query.includes(`FROM ${db.table('observations')}`) &&
          query.includes('ORDER BY started_at'),
      ),
    ).toBe(false);
  });

  it('refreshes only live-day aggregates on warm idle publication without raw history or sample shards', async () => {
    const { db } = makeDatabase();
    await seedPage(db, 106);
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
    const tracked = trackedDatabase(db, queries);
    await publishDueReports(config(tracked, reports), new Date(now.getTime() + 60_000), log);
    expect(reads).toEqual([reportCohortPointerKey, reportCohortUptimeCacheKey]);
    expect(
      queries.filter((query) => query.includes(`FROM ${db.table('monitor_daily_uptime')}`)),
    ).toHaveLength(1);
    expect(
      queries.find((query) => query.includes(`FROM ${db.table('monitor_daily_uptime')}`)),
    ).toContain('day = $');
    const observationReads = queries.filter((query) =>
      query.includes(`FROM ${db.table('observations')}`),
    );
    expect(observationReads).toHaveLength(2);
    // Recovery uses indexed latest-failure/live-day seeks and five recent probes,
    // rather than the raw history scan formerly used for each monitor chart.
    expect(observationReads.every((query) => query.includes('scheduled_window'))).toBe(true);
    expect(observationReads.some((query) => query.includes('started_at >= $'))).toBe(false);
    expect(reports.store.get(reportCohortUptimeCacheKey)!.etag).toBe(cache);
    expect(queries.length).toBeLessThan(25);
  });

  it('refreshes the live day and invalidates closed days after a late correction', async () => {
    const { db } = makeDatabase();
    await seedPage(db);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    await seedRound(db, {
      id: 'late-run',
      monitorId: 'member-0',
      windowStartedAt: '2026-09-20T12:00:30.000Z',
      status: 'complete',
    });
    await seedObservation(db, {
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
    await seedRound(db, {
      id: 'closed-late-run',
      monitorId: 'member-0',
      windowStartedAt: '2026-09-20T12:00:45.000Z',
      status: 'complete',
    });
    await seedObservation(db, {
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
    const { db } = makeDatabase();
    await seedPage(db);
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
    const { db } = makeDatabase();
    await seedPage(db);
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
    const { db } = makeDatabase();
    await seedPage(db);
    const reports = new FakeR2();
    await publishDueReports(config(db, reports), now, log);
    const put = reports.put.bind(reports);
    reports.put = async (key, value, options) => {
      if (key.endsWith('/status-pages.json'))
        await execute(db, `DELETE FROM ${db.table('status_pages')} WHERE id = 'page'`);
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
    const { db } = makeDatabase();
    await seedPage(db);
    const reports = new FakeR2();
    const legacy = monitorObjectKey('old');
    await reports.put(legacy, '{}');
    await execute(
      db,
      `INSERT INTO ${db.table('report_publications')} (report_key, kind, object_key, schema_version) VALUES ('monitor:old', 'monitor', $1, '1')`,
      [legacy],
    );
    const old = String(now.getTime() - 1_200_000);
    const recent = String(now.getTime() - 60_000);
    await reports.put(`public/cohorts/${old}/monitors-0.json`, '{}');
    await reports.put(`public/cohorts/${recent}/monitors-0.json`, '{}');
    await publishDueReports(config(db, reports), now, log);
    expect(reports.store.has(legacy)).toBe(false);
    expect(reports.store.has(`public/cohorts/${old}/monitors-0.json`)).toBe(false);
    expect(reports.store.has(`public/cohorts/${recent}/monitors-0.json`)).toBe(true);
    expect(await count(db, 'report_publications')).toBe(1);
  });

  it('retains only five committed generations', async () => {
    const { db } = makeDatabase();
    await seedPage(db);
    const reports = new FakeR2();
    for (let tick = 0; tick < 6; tick += 1)
      await publishDueReports(config(db, reports), new Date(now.getTime() + tick * 60_000), log);
    expect(pointer(reports).previousGenerations).toHaveLength(4);
    expect(reports.store.has(reportCohortIndexKey(String(now.getTime())))).toBe(false);
  });
});
