import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { aggregateLatencyBucketIntervals, buildApi, latencyBucketIntervals } from './server.js';

const monitorId = '60127b00-b86d-4e7a-8f43-63edb60b7abf';
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

async function env() {
  return {
    DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
    SESSION_COOKIE_SECURE: false,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD_HASH: await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    }),
    SESSION_SECRET: 'a'.repeat(32),
  };
}

function queuedDatabase(...responses: object[][]) {
  let index = 0;
  return {
    execute: async () => ({ rows: responses[index++] ?? [] }),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public monitor sharing', () => {
  it.each([
    ['1h', '5 minutes'],
    ['24h', '15 minutes'],
    ['7d', '1 hour'],
    ['30d', '6 hours'],
  ] as const)('uses %s latency buckets of %s', (range, interval) => {
    expect(latencyBucketIntervals[range]).toBe(interval);
  });

  it.each([
    ['1h', '1 minute'],
    ['24h', '5 minutes'],
    ['7d', '15 minutes'],
    ['30d', '1 hour'],
  ] as const)('uses finer %s all-region latency buckets of %s', (range, interval) => {
    expect(aggregateLatencyBucketIntervals[range]).toBe(interval);
  });

  it('serves a public summary without request evidence or DNS data', async () => {
    const app = await buildApi(await env(), {
      db: queuedDatabase(
        [], // singleton admin insert
        [
          {
            id: monitorId,
            name: 'Example',
            url: 'https://example.com',
            intervalSeconds: 60,
            timeoutMs: 1_000,
            enabled: true,
            dnsDiagnosticsEnabled: true,
            isPublic: true,
            notificationServiceIds: ['20000000-0000-4000-8000-000000000001'],
            outageThreshold: 5,
            recoveryThreshold: 4,
            repeatNotificationMinutes: 60,
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
        [{ regionId: 'us-east' }],
        [],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/monitors/public/${monitorId}` });

    expect(response.statusCode).toBe(200);
    const summary = response.json().summary;
    expect(summary.monitor).toMatchObject({ id: monitorId, isPublic: true });
    expect(summary.monitor).not.toHaveProperty('dnsDiagnosticsEnabled');
    expect(summary.monitor).not.toHaveProperty('notificationServiceIds');
    expect(summary.monitor).not.toHaveProperty('outageThreshold');
    expect(summary.monitor).not.toHaveProperty('recoveryThreshold');
    expect(summary.monitor).not.toHaveProperty('repeatNotificationMinutes');
    expect(summary).not.toHaveProperty('observations');
    expect(summary).not.toHaveProperty('diagnostics');
  });

  it('resolves a public monitor by its custom slug', async () => {
    const app = await buildApi(await env(), {
      db: queuedDatabase(
        [],
        [
          {
            id: monitorId,
            name: 'Example',
            url: 'https://example.com',
            publicSlug: 'example-status',
            intervalSeconds: 60,
            timeoutMs: 1_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: true,
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
        [{ regionId: 'us-east' }],
        [],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/monitors/public/example-status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().summary.monitor.publicSlug).toBe('example-status');
  });

  it('returns 404 for private or missing monitors without requiring authentication', async () => {
    const app = await buildApi(await env(), { db: queuedDatabase([], []) as never });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/monitors/public/${monitorId}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Monitor was not found' },
    });
  });

  it('serves aggregate latency data for a public monitor', async () => {
    const app = await buildApi(await env(), {
      db: queuedDatabase(
        [], // singleton admin insert
        [
          {
            id: monitorId,
            name: 'Example',
            url: 'https://example.com',
            intervalSeconds: 60,
            timeoutMs: 1_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: true,
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
        [
          {
            observedAt: '2026-08-30T00:00:00.000Z',
            regionId: 'us-east',
            responseMs: '42.5',
            success: true,
          },
        ],
        [
          {
            observedAt: '2026-08-30T00:00:00.000Z',
            responseMs: '43.25',
            success: true,
          },
        ],
        [
          {
            regionId: 'us-east',
            sampleCount: 1_001,
            successCount: 1_000,
            p50Ms: 41,
            p95Ms: 75,
            p99Ms: 110,
          },
        ],
        [
          {
            averageResponseMs: '43.25',
            maximumResponseMs: 110,
            maximumResponseRegionId: 'us-east',
            minimumResponseMs: 21,
          },
        ],
        [{ regionId: 'us-east' }],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/public/${monitorId}/latency?range=24h`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      range: '24h',
      points: [
        {
          observedAt: '2026-08-30T00:00:00.000Z',
          regionId: 'us-east',
          responseMs: 42.5,
          success: true,
        },
      ],
      stats: [
        {
          regionId: 'us-east',
          // Exact stats are independent of the bucketed chart points.
          sampleCount: 1_001,
          successCount: 1_000,
          p50Ms: 41,
          p95Ms: 75,
          p99Ms: 110,
        },
      ],
      aggregatePoints: [
        {
          observedAt: '2026-08-30T00:00:00.000Z',
          responseMs: 43.25,
          success: true,
        },
      ],
      aggregateStats: {
        averageResponseMs: 43.25,
        maximumResponseMs: 110,
        maximumResponseRegionId: 'us-east',
        minimumResponseMs: 21,
      },
    });
  });

  it('returns 404 from the public latency endpoint for private or missing monitors', async () => {
    const app = await buildApi(await env(), { db: queuedDatabase([], []) as never });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/public/${monitorId}/latency`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Monitor was not found' },
    });
  });
});
