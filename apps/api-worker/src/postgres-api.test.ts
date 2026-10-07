import { afterEach, describe, expect, it } from 'vitest';
import type { monitorSummary, latencyPayload, monitorUptimePayload } from './queries.js';

import {
  createTestContext,
  login,
  request,
  seedObservation,
  seedRun,
  type TestContext,
} from './testing/test-utils.js';

const contexts: TestContext[] = [];
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function context() {
  let now = new Date('2026-10-05T11:59:00.000Z');
  const ctx = await createTestContext({ now: () => now });
  contexts.push(ctx);
  return {
    ...ctx,
    advanceNow: () => {
      now = new Date('2026-10-05T12:10:00.000Z');
    },
  };
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
});

describe('native postgres api integration', () => {
  it('executes monitor lifecycle, observations, and rollup status against PostgreSQL', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);

    // 1. Health check
    const health = await request(ctx.app, '/health');
    expect(health.status).toBe(200);
    expect(await json(health)).toMatchObject({ status: 'ok' });

    // 2. Create monitor
    const created = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Native PG Monitor',
        url: 'https://example.com/api',
        regionIds: ['us-east', 'eu-west'],
        intervalSeconds: 60,
        timeoutMs: 5000,
        enabled: true,
        dnsDiagnosticsEnabled: false,
        isPublic: true,
        publicSlug: 'pg-monitor',
      }),
    });
    expect(created.status).toBe(201);
    const { summary } = await json<{ summary: Awaited<ReturnType<typeof monitorSummary>> }>(
      created,
    );
    const monitorId = summary.monitor.id;
    expect(summary.monitor.name).toBe('Native PG Monitor');
    ctx.advanceNow();

    // 3. Seed run and observations
    const runId = await seedRun(ctx.db, {
      monitorId,
      status: 'complete',
      expectedRegionCount: 2,
      windowStartedAt: '2026-10-05T12:00:00.000Z',
    });
    await seedObservation(ctx.db, {
      checkRunId: runId,
      monitorId,
      regionId: 'us-east',
      success: true,
      responseMs: 85,
      startedAt: '2026-10-05T12:00:05.000Z',
    });
    await seedObservation(ctx.db, {
      checkRunId: runId,
      monitorId,
      regionId: 'eu-west',
      success: true,
      responseMs: 95,
      startedAt: '2026-10-05T12:00:06.000Z',
    });

    // 4. Fetch monitor summary
    const summaryRes = await request(ctx.app, `/api/monitors/${monitorId}`, { cookie });
    expect(summaryRes.status).toBe(200);
    const fetched = (
      await json<{ summary: Awaited<ReturnType<typeof monitorSummary>> }>(summaryRes)
    ).summary;
    expect(fetched.status).toBe('up');
    expect(fetched.latestByRegion['us-east']?.responseMs).toBe(85);
    expect(fetched.latestByRegion['eu-west']?.responseMs).toBe(95);

    // 5. Query latency
    const latencyRes = await request(ctx.app, `/api/monitors/${monitorId}/latency?range=24h`, {
      cookie,
    });
    expect(latencyRes.status).toBe(200);
    const latency = await json<Awaited<ReturnType<typeof latencyPayload>>>(latencyRes);
    expect(latency.aggregateStats.averageResponseMs).toBe(90);

    // 6. Query public uptime
    const uptimeRes = await request(ctx.app, '/api/monitors/public/pg-monitor/uptime');
    expect(uptimeRes.status).toBe(200);
    const uptime = (
      await json<{ uptime: Awaited<ReturnType<typeof monitorUptimePayload>> }>(uptimeRes)
    ).uptime;
    expect(uptime.status).toBe('up');
    expect(uptime.days).toHaveLength(90);
  });
});
