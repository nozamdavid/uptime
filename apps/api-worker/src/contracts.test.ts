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

describe('observation evidence projection', () => {
  it('parses valid endpoint evidence and drops evidence whose hostname mismatches', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const run = seedRun(ctx.sqlite, { monitorId: id, status: 'complete' });
    const evidence = {
      finalHostname: 'example.com',
      signals: [{ name: 'server', value: 'nginx' }],
      primaryCdn: null,
    };
    ctx.sqlite
      .prepare(
        `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window, status,
           success, http_status, response_ms, final_url, endpoint_evidence, started_at, completed_at)
         VALUES (?, ?, ?, 'us-east', '2026-09-16T10:00:00.000Z', 'success', 1, 200, 100,
           'https://example.com/', ?, '2026-09-16T10:00:05.000Z', '2026-09-16T10:00:06.000Z')`,
      )
      .run('60000000-0000-4000-8000-000000000001', run, id, JSON.stringify(evidence));
    // Mismatched hostname and malformed JSON must both be ignored.
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      regionId: 'eu-west',
      startedAt: '2026-09-16T10:01:05.000Z',
    });
    ctx.sqlite
      .prepare(
        `UPDATE observations SET final_url = 'https://other.example/', endpoint_evidence = ? WHERE region_id = 'eu-west'`,
      )
      .run(JSON.stringify(evidence));

    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}/observations?range=24h`, {
      cookie,
    });
    const observations = (await json(response)).observations;
    const east = observations.find((o: { regionId: string }) => o.regionId === 'us-east');
    const west = observations.find((o: { regionId: string }) => o.regionId === 'eu-west');
    expect(east.endpointEvidence).toEqual(evidence);
    expect(west.endpointEvidence).toBeNull();
  });
});

describe('weighted uptime semantics', () => {
  it('weights imported closed days by explicit weight and computes the live day', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true });
    // Imported closed day with an explicit weight and no counts.
    ctx.sqlite
      .prepare(
        `INSERT INTO monitor_daily_uptime
           (monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count)
         VALUES (?, '2026-09-15', 95, 130, 288, NULL, NULL)`,
      )
      .run(id);
    // Live day: 9/10 successes.
    for (let index = 0; index < 10; index += 1) {
      const run = seedRun(ctx.sqlite, {
        monitorId: id,
        status: 'complete',
        windowStartedAt: `2026-09-16T0${index}:00:00.000Z`,
      });
      seedObservation(ctx.sqlite, {
        checkRunId: run,
        monitorId: id,
        success: index !== 0,
        status: index === 0 ? 'http_failure' : 'success',
        httpStatus: index === 0 ? 500 : 200,
        responseMs: index === 0 ? null : 100,
        scheduledWindow: `2026-09-16T0${index}:00:00.000Z`,
        startedAt: `2026-09-16T0${index}:00:05.000Z`,
      });
    }
    const response = await request(ctx.app, `/api/monitors/public/${id}/uptime`);
    const uptime = (await json(response)).uptime;
    expect(uptime.days.at(-2)).toMatchObject({ date: '2026-09-15', uptimePercentage: 95 });
    expect(uptime.days.at(-1)).toMatchObject({ date: '2026-09-16', uptimePercentage: 90 });
    expect(uptime.uptimePercentage).toBeCloseTo((95 * 288 + 90 * 10) / 298);
  });

  it('reports unknown when no day has measurements', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true });
    const response = await request(ctx.app, `/api/monitors/public/${id}/uptime`);
    const uptime = (await json(response)).uptime;
    expect(uptime.uptimePercentage).toBeNull();
    expect(uptime.status).toBe('unknown');
    expect(uptime.days).toHaveLength(90);
  });

  it('falls back exactly to raw observations only when a daily rollup is missing', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true });
    const run = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'complete',
      windowStartedAt: '2026-09-15T10:00:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      success: false,
      status: 'http_failure',
      scheduledWindow: '2026-09-15T10:00:00.000Z',
      startedAt: '2026-09-15T10:00:05.000Z',
    });
    // Simulate a legacy/imported gap; normal D1 writes maintain this row by trigger.
    ctx.sqlite
      .prepare('DELETE FROM monitor_daily_uptime WHERE monitor_id = ? AND day = ?')
      .run(id, '2026-09-15');
    const response = await request(ctx.app, `/api/monitors/public/${id}/uptime`);
    const uptime = (await json(response)).uptime;
    expect(uptime.days.at(-2)).toMatchObject({ date: '2026-09-15', uptimePercentage: 0 });
  });

  it('treats missing probe results as unknown, not healthy', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { isPublic: true, regions: ['us-east', 'eu-west'] });
    const run = seedRun(ctx.sqlite, {
      monitorId: id,
      status: 'partial',
      expectedRegionCount: 2,
      windowStartedAt: '2026-09-16T10:00:00.000Z',
    });
    // Only one of two expected regions reported.
    seedObservation(ctx.sqlite, {
      checkRunId: run,
      monitorId: id,
      regionId: 'us-east',
      success: true,
      scheduledWindow: '2026-09-16T10:00:00.000Z',
      startedAt: '2026-09-16T10:00:05.000Z',
    });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}`, { cookie });
    const summary = (await json(response)).summary;
    // The missing eu-west observation is null rather than a synthesized result.
    expect(summary.latestByRegion['eu-west']).toBeNull();
    expect(summary.latestByRegion['us-east'].success).toBe(true);
    expect(summary.status).toBe('unknown');
  });
});
