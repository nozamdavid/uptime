import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestContext,
  login,
  request,
  seedMonitor,
  seedObservation,
  seedRun,
  type TestContext,
} from './testing/test-utils.js';

const contexts: TestContext[] = [];
const json = (response: Response): Promise<any> => response.json();

const now = () => new Date('2026-09-16T12:00:00.000Z');

async function context() {
  const ctx = await createTestContext({ now });
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

describe('public monitor views', () => {
  it('serves a public summary without private fields or diagnostics', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, {
      isPublic: true,
      dnsDiagnosticsEnabled: true,
      regions: ['us-east', 'eu-west'],
    });
    // Latest round: one success, one failure.
    const run = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      expectedRegionCount: 2,
      windowStartedAt: '2026-09-16T11:59:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      regionId: 'us-east',
      success: true,
      responseMs: 120,
      startedAt: '2026-09-16T11:59:05.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      regionId: 'eu-west',
      status: 'http_failure',
      success: false,
      httpStatus: 500,
      startedAt: '2026-09-16T11:59:05.000Z',
    });
    const response = await request(ctx.app, `/api/monitors/public/${id}`);
    expect(response.status).toBe(200);
    const { summary } = await json(response);
    expect(summary.status).toBe('degraded');
    expect(summary.monitor).not.toHaveProperty('dnsDiagnosticsEnabled');
    expect(summary.monitor).not.toHaveProperty('notificationServiceIds');
    expect(summary.monitor).not.toHaveProperty('outageThreshold');
    expect(summary.latestByRegion['us-east'].responseMs).toBe(120);
    expect(summary.latestByRegion['eu-west'].errorCode).toBeNull();
  });

  it('resolves a public monitor by slug and hides private monitors', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true, publicSlug: 'website' });
    const bySlug = await request(ctx.app, '/api/monitors/public/website');
    expect(bySlug.status).toBe(200);
    expect((await json(bySlug)).summary.monitor.id).toBe(id);

    const privateId = seedMonitor(ctx.sqlite, {
      id: '30000000-0000-4000-8000-000000000002',
      isPublic: false,
    });
    const hidden = await request(ctx.app, `/api/monitors/public/${privateId}`);
    expect(hidden.status).toBe(404);
  });

  it('returns aggregate latency with exact percentiles', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true });
    const samples = [100, 200, 300, 400, 500];
    let index = 0;
    for (const value of samples) {
      const run = seedRun(ctx.sqlite, {
        monitorId: id,
        status: 'complete',
        windowStartedAt: `2026-09-16T11:5${index}:00.000Z`,
      });
      seedObservation(ctx.sqlite, {
        checkRunId: run,
        monitorId: id,
        responseMs: value,
        startedAt: `2026-09-16T11:5${index}:05.000Z`,
      });
      index += 1;
    }
    const response = await request(ctx.app, `/api/monitors/public/${id}/latency?range=24h`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.range).toBe('24h');
    const stats = body.stats.find((s: { regionId: string }) => s.regionId === 'us-east');
    expect(stats.sampleCount).toBe(5);
    expect(stats.successCount).toBe(5);
    expect(stats.p50Ms).toBe(300);
    expect(stats.p95Ms).toBe(500);
    expect(body.aggregateStats.averageResponseMs).toBe(300);
    expect(body.aggregateStats.maximumResponseMs).toBe(500);
    expect(body.aggregateStats.minimumResponseMs).toBe(100);
    expect(body.aggregateStats.maximumResponseRegionId).toBe('us-east');
  });

  it('averages per-region bucket averages for the aggregate latency series', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true, regions: ['us-east', 'eu-west'] });
    // Same 5-minute aggregate bucket, unequal sample counts per region. The
    // aggregate is the mean of regional averages (100 and 200), not raw rows.
    const east = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      windowStartedAt: '2026-09-16T11:55:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: east,
      monitorId: id,
      regionId: 'us-east',
      responseMs: 100,
      startedAt: '2026-09-16T11:55:05.000Z',
    });
    const westA = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      windowStartedAt: '2026-09-16T11:56:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: westA,
      monitorId: id,
      regionId: 'eu-west',
      responseMs: 200,
      startedAt: '2026-09-16T11:56:05.000Z',
    });
    const westB = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      windowStartedAt: '2026-09-16T11:57:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: westB,
      monitorId: id,
      regionId: 'eu-west',
      responseMs: 200,
      startedAt: '2026-09-16T11:57:05.000Z',
    });
    const response = await request(ctx.app, `/api/monitors/public/${id}/latency?range=24h`);
    const body = await json(response);
    // Raw-sample average would be (100 + 200 + 200) / 3 = 166.67.
    expect(body.aggregatePoints.at(-1).responseMs).toBe(150);
  });

  it('serves the 90-day uptime strip for a public monitor', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true });
    const run = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      windowStartedAt: '2026-09-16T10:00:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      success: false,
      status: 'http_failure',
      httpStatus: 503,
      startedAt: '2026-09-16T10:00:05.000Z',
    });
    const response = await request(ctx.app, `/api/monitors/public/${id}/uptime`);
    expect(response.status).toBe(200);
    const uptime = (await json(response)).uptime;
    expect(uptime.days).toHaveLength(90);
    expect(uptime.days.at(-1)).toMatchObject({ date: '2026-09-16', uptimePercentage: 0 });
    expect(uptime.status).toBe('down');
  });
});

describe('public status pages', () => {
  it('resolves a public status page by slug with per-monitor uptime', async () => {
    const ctx = await context();
    const monitorId = seedMonitor(ctx.sqlite, {
      id: '30000000-0000-4000-8000-000000000001',
      regions: ['us-east', 'eu-west'],
      thresholds: { green: 99.9, lightGreen: 99, orange: 95 },
    });
    // Yesterday rollup + today's observation.
    ctx.sqlite
      .prepare(
        `INSERT INTO monitor_daily_uptime
           (monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count)
         VALUES (?, '2026-09-15', 100, 50, 10, 10, 10)`,
      )
      .run(monitorId);
    const run = seedRun(ctx.sqlite, {
      monitorId,
      status: 'complete',
      expectedRegionCount: 2,
      windowStartedAt: '2026-09-16T10:00:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId,
      regionId: 'us-east',
      success: true,
      responseMs: 100,
      startedAt: '2026-09-16T10:00:05.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId,
      regionId: 'eu-west',
      success: false,
      status: 'http_failure',
      httpStatus: 500,
      startedAt: '2026-09-16T10:00:05.000Z',
    });

    const created = await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie: (await login(ctx.app)).cookie,
      body: JSON.stringify({
        title: 'Acme',
        publicSlug: 'acme',
        groups: [{ title: 'Core', monitorIds: [monitorId], width: 'full', showBadges: true }],
      }),
    });
    expect(created.status).toBe(201);

    const response = await request(ctx.app, '/api/status-pages/public/acme');
    expect(response.status).toBe(200);
    const page = (await json(response)).statusPage;
    const monitor = page.groups[0].monitors[0];
    expect(monitor.days).toHaveLength(90);
    expect(monitor.days.at(-2)).toMatchObject({ date: '2026-09-15', uptimePercentage: 100 });
    expect(monitor.days.at(-1)).toMatchObject({ date: '2026-09-16', uptimePercentage: 50 });
    expect(monitor.configuredRegionCount).toBe(2);
    expect(monitor.affectedRegionIds).toEqual(['eu-west']);
    expect(monitor.recoveryStatus).toBe('down');
    expect(monitor.uptimeThresholds).toEqual({ green: 99.9, lightGreen: 99, orange: 95 });
  });

  it('reports an incomplete latest round as unknown despite successful received probes', async () => {
    const ctx = await context();
    const monitorId = seedMonitor(ctx.sqlite, {
      id: '30000000-0000-4000-8000-000000000001',
      regions: ['us-east', 'eu-west'],
    });
    const run = seedRun(ctx.sqlite, {
      monitorId,
      status: 'partial',
      expectedRegionCount: 2,
      windowStartedAt: '2026-09-16T10:00:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId,
      regionId: 'us-east',
      success: true,
      startedAt: '2026-09-16T10:00:05.000Z',
    });
    await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie: (await login(ctx.app)).cookie,
      body: JSON.stringify({
        title: 'Acme',
        publicSlug: 'acme',
        groups: [{ title: 'Core', monitorIds: [monitorId], width: 'full', showBadges: true }],
      }),
    });

    const response = await request(ctx.app, '/api/status-pages/public/acme');
    const monitor = (await json(response)).statusPage.groups[0].monitors[0];
    expect(monitor.days.at(-1)).toMatchObject({ uptimePercentage: 100 });
    expect(monitor.status).toBe('unknown');
  });

  it('returns 404 without authentication for a missing page', async () => {
    const ctx = await context();
    const response = await request(
      ctx.app,
      '/api/status-pages/public/10000000-0000-4000-8000-000000000001',
    );
    expect(response.status).toBe(404);
  });
});

describe('private history', () => {
  it('paginates observations with a cursor and region filter', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    for (let index = 0; index < 5; index += 1) {
      const run = seedRun(ctx.sqlite, {
        monitorId: id,
        status: 'complete',
        windowStartedAt: `2026-09-16T11:0${index}:00.000Z`,
      });
      seedObservation(ctx.sqlite, {
        checkRunId: run,
        monitorId: id,
        scheduledWindow: `2026-09-16T11:0${index}:00.000Z`,
        startedAt: `2026-09-16T11:0${index}:05.000Z`,
      });
    }
    const { cookie } = await login(ctx.app);
    const first = await request(ctx.app, `/api/monitors/${id}/observations?range=24h&limit=2`, {
      cookie,
    });
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.observations).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await request(
      ctx.app,
      `/api/monitors/${id}/observations?range=24h&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { cookie },
    );
    const secondBody = await json(second);
    expect(secondBody.observations[0].startedAt).not.toBe(firstBody.observations[0].startedAt);
  });

  it('rejects a malformed cursor', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const { cookie } = await login(ctx.app);
    const response = await request(
      ctx.app,
      `/api/monitors/${id}/observations?cursor=not-a-cursor`,
      {
        cookie,
      },
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('invalid_cursor');
  });

  it('paginates DNS diagnostics', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { dnsDiagnosticsEnabled: true });
    ctx.sqlite
      .prepare(
        `INSERT INTO network_diagnostics (id, monitor_id, region_id, window_started_at, lifecycle,
           result, requested_at, completed_at)
         VALUES (?, ?, 'us-east', '2026-09-16T10:00:00.000Z', 'complete', ?, '2026-09-16T10:00:00.000Z', '2026-09-16T10:00:01.000Z')`,
      )
      .run(
        '50000000-0000-4000-8000-000000000001',
        id,
        JSON.stringify({
          diagnosticId: '50000000-0000-4000-8000-000000000001',
          windowStartedAt: '2026-09-16T10:00:00.000Z',
          finalHostname: 'example.com',
          resolver: 'cloudflare-doh',
          observedAt: '2026-09-16T10:00:01.000Z',
          status: 'success',
          cnameCandidates: [],
          aCandidates: [{ address: '1.1.1.1', ttl: 60 }],
          aaaaCandidates: [],
          filteredAddressCount: 0,
          errorCode: null,
          schemaVersion: '1',
          parserVersion: '1',
        }),
      );
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}/dns-diagnostics?range=7d`, {
      cookie,
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0]).toMatchObject({
      lifecycle: 'complete',
      finalHostname: 'example.com',
    });
  });

  it('treats a malformed percent-encoded id as not found instead of a 500', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors/%2/uptime', { cookie });
    expect(response.status).toBe(404);
  });

  it('returns invalid_cursor for a corrupt base64 cursor', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}/observations?cursor=%25%25%25`, {
      cookie,
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('invalid_cursor');
  });

  it('requires authentication for observations and diagnostics', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    expect((await request(ctx.app, `/api/monitors/${id}/observations`)).status).toBe(401);
    expect((await request(ctx.app, `/api/monitors/${id}/dns-diagnostics`)).status).toBe(401);
    expect((await request(ctx.app, `/api/monitors/${id}/latency`)).status).toBe(401);
  });
});
