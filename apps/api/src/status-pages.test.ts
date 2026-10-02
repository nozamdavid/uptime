import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from './server.js';

const pageId = '10000000-0000-4000-8000-000000000001';
const groupId = '20000000-0000-4000-8000-000000000001';
const monitorId = '30000000-0000-4000-8000-000000000001';
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
  return { execute: async () => ({ rows: responses[index++] ?? [] }) };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public status pages', () => {
  it('resolves a public status page by its custom slug', async () => {
    const app = await buildApi(await env(), {
      now: () => new Date('2026-08-30T18:00:00.000Z'),
      db: queuedDatabase(
        [],
        [{ id: pageId }],
        [
          {
            id: pageId,
            title: 'System status',
            publicSlug: 'system.status',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        [],
        [],
        [],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/status-pages/public/system.status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().statusPage).toMatchObject({
      id: pageId,
      publicSlug: 'system.status',
    });
  });

  it('counts worker failures as downtime and excludes missing worker responses', async () => {
    const app = await buildApi(await env(), {
      now: () => new Date('2026-08-30T18:00:00.000Z'),
      db: queuedDatabase(
        [],
        [
          {
            id: pageId,
            title: 'System status',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        [{ id: groupId, title: 'Core services', position: 0 }],
        [
          {
            groupId,
            id: monitorId,
            name: 'Website',
            url: 'https://example.com',
            position: 0,
          },
        ],
        [
          {
            monitorId,
            day: '2026-08-29',
            expectedCount: 10,
            receivedCount: 10,
            successCount: 9,
            averageResponseMs: 120,
          },
          {
            monitorId,
            day: '2026-08-30',
            expectedCount: 10,
            receivedCount: 9,
            successCount: 9,
            averageResponseMs: 123.456,
          },
        ],
        [
          {
            monitorId,
            configuredRegionCount: 4,
            affectedRegionIds: ['eu-west', 'asia-south'],
            recoveryStatus: 'down',
          },
        ],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/status-pages/public/${pageId}`,
    });

    expect(response.statusCode).toBe(200);
    const page = response.json().statusPage;
    const monitor = page.groups[0].monitors[0];
    expect(page.title).toBe('System status');
    expect(monitor.days).toHaveLength(90);
    expect(monitor.days[0].date).toBe('2026-06-02');
    expect(monitor.days.at(-2)).toEqual({
      date: '2026-08-29',
      uptimePercentage: 90,
      averageResponseMs: 120,
    });
    expect(monitor.days.at(-1)).toEqual({
      date: '2026-08-30',
      uptimePercentage: 100,
      averageResponseMs: 123.456,
    });
    expect(monitor.status).toBe('up');
    expect(monitor.configuredRegionCount).toBe(4);
    expect(monitor.affectedRegionIds).toEqual(['eu-west', 'asia-south']);
    expect(monitor.recoveryStatus).toBe('down');
    expect(monitor.uptimePercentage).toBeCloseTo((18 / 19) * 100);
  });

  it('returns 404 without authentication when the status page does not exist', async () => {
    const app = await buildApi(await env(), { db: queuedDatabase([], []) as never });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/status-pages/public/${pageId}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
