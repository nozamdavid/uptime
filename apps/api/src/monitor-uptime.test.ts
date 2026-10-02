import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from './server.js';

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

describe('monitor uptime history', () => {
  it('serves the same 90-day uptime strip on a public monitor', async () => {
    const app = await buildApi(await env(), {
      now: () => new Date('2026-08-30T18:00:00.000Z'),
      db: queuedDatabase(
        [],
        [
          {
            id: monitorId,
            name: 'Website',
            url: 'https://example.com',
            intervalSeconds: 60,
            timeoutMs: 10_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: true,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        [
          {
            monitorId,
            day: '2026-08-30',
            expectedCount: 10,
            receivedCount: 10,
            successCount: 9,
            averageResponseMs: 123.456,
          },
        ],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/public/${monitorId}/uptime`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().uptime).toMatchObject({
      uptimePercentage: 90,
      status: 'down',
    });
    expect(response.json().uptime.days).toHaveLength(90);
    expect(response.json().uptime.days.at(-1)).toEqual({
      date: '2026-08-30',
      uptimePercentage: 90,
      averageResponseMs: 123.456,
    });
  });

  it('combines imported closed days with the live current UTC day', async () => {
    const app = await buildApi(await env(), {
      now: () => new Date('2026-08-30T18:00:00.000Z'),
      db: queuedDatabase(
        [],
        [
          {
            id: monitorId,
            name: 'Website',
            url: 'https://example.com',
            intervalSeconds: 60,
            timeoutMs: 10_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: true,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        [
          {
            monitorId,
            day: '2026-08-29',
            uptimePercentage: 95,
            weight: 288,
            receivedCount: null,
            successCount: null,
            averageResponseMs: 130,
          },
          {
            monitorId,
            day: '2026-08-30',
            uptimePercentage: 90,
            weight: 10,
            receivedCount: 10,
            successCount: 9,
            averageResponseMs: 123,
          },
        ],
      ) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/monitors/public/${monitorId}/uptime`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().uptime.uptimePercentage).toBeCloseTo((95 * 288 + 90 * 10) / 298);
    expect(response.json().uptime.days.at(-2)).toMatchObject({
      date: '2026-08-29',
      uptimePercentage: 95,
    });
    expect(response.json().uptime.days.at(-1)).toMatchObject({
      date: '2026-08-30',
      uptimePercentage: 90,
    });
  });
});
