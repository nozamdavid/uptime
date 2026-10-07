import { describe, expect, it, vi, afterEach } from 'vitest';
import { handleMonitorReport } from './on-demand-monitor.js';
import type { MonitorReportSnapshot } from './report-types.js';
import { FakeR2 } from './testing-r2.js';
import { useTenantDatabase, seedMonitor } from './testing-postgres.js';

const makeDatabase = useTenantDatabase();
const makeOtherDatabase = useTenantDatabase();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('direct monitor reports', () => {
  it('reads Postgres once per 60 seconds, never writes reports, and checks visibility on hits', async () => {
    const { db } = makeDatabase();
    const id = await seedMonitor(db, { isPublic: 1, publicSlug: 'example' });
    const reports = new FakeR2();
    const query = vi.spyOn(db, 'query');
    const get = (method = 'GET') =>
      handleMonitorReport(
        new Request('https://reporter/reports/public/monitors/example.json', { method }),
        { DB: db, REPORTS: reports },
      );
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = await get();
    expect(first.status).toBe(200);
    expect(Object.keys(((await first.json()) as MonitorReportSnapshot).latencyByRange!)).toEqual([
      '1h',
      '24h',
      '7d',
      '30d',
    ]);
    query.mockClear();
    vi.mocked(Date.now).mockReturnValue(60_999);
    expect((await get()).status).toBe(200);
    expect(query.mock.calls.every(([sql]) => sql.includes('notification_service_ids'))).toBe(true);
    query.mockClear();
    vi.mocked(Date.now).mockReturnValue(61_000);
    expect((await get()).status).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.includes('observations'))).toBe(true);
    expect(reports.store.size).toBe(0);
    expect(await (await get('HEAD')).text()).toBe('');
    await db.query(`UPDATE ${db.table('monitors')} SET is_public = 0 WHERE id = $1`, [id]);
    expect((await get()).status).toBe(404);
    vi.restoreAllMocks();
  });

  it('isolates monitors with the same reference in different schemas', async () => {
    const left = makeDatabase().db;
    const right = makeOtherDatabase().db;
    await seedMonitor(left, { id: 'same-id', name: 'Left', isPublic: 1, publicSlug: 'example' });
    await seedMonitor(right, { id: 'same-id', name: 'Right', isPublic: 1, publicSlug: 'example' });
    for (const [db, name] of [
      [left, 'Left'],
      [right, 'Right'],
    ] as const) {
      const response = await handleMonitorReport(
        new Request('https://reporter/reports/public/monitors/example.json'),
        { DB: db, REPORTS: new FakeR2() },
      );
      expect(((await response.json()) as MonitorReportSnapshot).summary.monitor.name).toBe(name);
    }
  });
});
