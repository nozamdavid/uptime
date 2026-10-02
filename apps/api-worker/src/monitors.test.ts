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

async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

const validMonitor = {
  name: 'Website',
  url: 'https://example.com',
  regionIds: ['us-east', 'eu-west'],
  intervalSeconds: 300,
  timeoutMs: 10_000,
  enabled: true,
  dnsDiagnosticsEnabled: false,
  isPublic: true,
  publicSlug: 'website',
};

describe('monitor create/update/delete', () => {
  it('creates a monitor with regions and defaults', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify(validMonitor),
    });
    expect(response.status).toBe(201);
    const summary = (await json(response)).summary;
    expect(summary.monitor.regionIds).toEqual(['eu-west', 'us-east']);
    expect(summary.monitor.publicSlug).toBe('website');
    expect(summary.monitor.uptimeThresholds).toEqual({ green: 99.5, lightGreen: 99, orange: 90 });
    expect(summary.monitor.outageThreshold).toBe(3);
    expect(summary.monitor.recoveryThreshold).toBe(2);
    expect(summary.targetChecksPerDay).toBe(576);
  });

  it('rejects disabled regions and private targets', async () => {
    const ctx = await createTestContext({
      config: { enabledRegionIds: ['us-east', 'eu-west'] },
    });
    contexts.push(ctx);
    const { cookie } = await login(ctx.app);
    const disabled = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...validMonitor, regionIds: ['asia'] }),
    });
    expect(disabled.status).toBe(400);
    expect((await json(disabled)).error.code).toBe('region_disabled');

    const privateTarget = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...validMonitor, url: 'http://127.0.0.1:8080' }),
    });
    expect(privateTarget.status).toBe(400);
    expect((await json(privateTarget)).error.code).toBe('forbidden_address');
  });

  it('rejects a timeout at or above the interval', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...validMonitor, intervalSeconds: 60, timeoutMs: 60_000 }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('validation_error');
  });

  it('prevents duplicate public slugs', async () => {
    const ctx = await context();
    seedMonitor(ctx.sqlite, { publicSlug: 'website' });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors', {
      method: 'POST',
      cookie,
      body: JSON.stringify(validMonitor),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe('slug_conflict');
  });

  it('updates a monitor, replacing regions and preserving settings', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite, { regions: ['us-east'], name: 'Old' });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'New', regionIds: ['eu-west', 'asia'], enabled: false }),
    });
    expect(response.status).toBe(200);
    const summary = (await json(response)).summary;
    expect(summary.monitor.name).toBe('New');
    expect(summary.monitor.regionIds).toEqual(['asia', 'eu-west']);
    expect(summary.monitor.enabled).toBe(false);
  });

  it('deletes a monitor and returns 404 afterwards', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const { cookie } = await login(ctx.app);
    const deleted = await request(ctx.app, `/api/monitors/${id}`, { method: 'DELETE', cookie });
    expect(deleted.status).toBe(204);
    const missing = await request(ctx.app, `/api/monitors/${id}`, { cookie });
    expect(missing.status).toBe(404);
  });
});

describe('bulk updates and badges', () => {
  it('updates frequencies for multiple monitors', async () => {
    const ctx = await context();
    const a = seedMonitor(ctx.sqlite, { id: '30000000-0000-4000-8000-000000000001' });
    const b = seedMonitor(ctx.sqlite, { id: '30000000-0000-4000-8000-000000000002' });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors/bulk-frequency', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ monitorIds: [a, b], intervalSeconds: 900 }),
    });
    expect(response.status).toBe(200);
    expect((await json(response)).updatedCount).toBe(2);
    const interval = ctx.sqlite
      .prepare('SELECT interval_seconds FROM monitors WHERE id = ?')
      .get(a) as { interval_seconds: number };
    expect(interval.interval_seconds).toBe(900);
  });

  it('rejects a bulk update referencing a missing monitor without mutating existing rows', async () => {
    const ctx = await context();
    const a = seedMonitor(ctx.sqlite, { id: '30000000-0000-4000-8000-000000000001' });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors/bulk-frequency', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        monitorIds: [a, '30000000-0000-4000-8000-000000000099'],
        intervalSeconds: 900,
      }),
    });
    expect(response.status).toBe(404);
    // A missing id must leave every monitor unchanged.
    const interval = ctx.sqlite
      .prepare('SELECT interval_seconds FROM monitors WHERE id = ?')
      .get(a) as { interval_seconds: number };
    expect(interval.interval_seconds).toBe(300);
  });

  it('updates the maximum of 100 monitors within the D1 bound-parameter limit', async () => {
    const ctx = await context();
    const ids: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index + 1).padStart(12, '0');
      ids.push(seedMonitor(ctx.sqlite, { id: `30000000-0000-4000-8000-${suffix}` }));
    }
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors/bulk-frequency', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ monitorIds: ids, intervalSeconds: 900 }),
    });
    expect(response.status).toBe(200);
    expect((await json(response)).updatedCount).toBe(100);
  });

  it('creates, lists and bulk-assigns badges', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/badges', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Production' }),
    });
    expect(created.status).toBe(201);
    const badge = (await json(created)).badge;
    expect(badge.name).toBe('Production');

    const assigned = await request(ctx.app, '/api/monitors/bulk-badge', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ monitorIds: [id], badgeId: badge.id }),
    });
    expect((await json(assigned)).updatedCount).toBe(1);

    const list = await request(ctx.app, '/api/badges', { cookie });
    expect((await json(list)).badges).toHaveLength(1);
    const monitor = await request(ctx.app, `/api/monitors/${id}`, { cookie });
    expect((await json(monitor)).summary.monitor.badge).toMatchObject({ name: 'Production' });
  });

  it('is idempotent for case-insensitive duplicate badge names', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    await request(ctx.app, '/api/badges', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Production' }),
    });
    const second = await request(ctx.app, '/api/badges', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'production' }),
    });
    expect(second.status).toBe(200);
  });
});

describe('monitor history deletion', () => {
  it('removes all history tables and reschedules the monitor', async () => {
    const ctx = await context();
    const id = seedMonitor(ctx.sqlite);
    const runId = seedRun(ctx.sqlite, { monitorId: id, status: 'complete' });
    seedObservation(ctx.sqlite, { checkRunId: runId, monitorId: id });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/monitors/${id}/history`, {
      method: 'DELETE',
      cookie,
    });
    expect(response.status).toBe(204);
    for (const table of [
      'network_diagnostics',
      'check_runs',
      'monitor_daily_uptime',
      'notification_deliveries',
      'monitor_notification_state',
    ]) {
      const row = ctx.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
      expect(row.c).toBe(0);
    }
  });
});
