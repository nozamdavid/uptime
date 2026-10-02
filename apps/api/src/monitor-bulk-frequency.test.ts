import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from './server.js';

const monitorIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('bulk monitor frequency updates', () => {
  it('updates all selected monitors in one request', async () => {
    const passwordHash = await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    });
    const responses = [
      [],
      [{ id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com', passwordHash }],
      [],
      [{ id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com' }],
      monitorIds.map((id) => ({ id })),
    ];
    const database = {
      execute: async () => ({ rows: responses.shift() ?? [] }),
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
    };
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: 'a'.repeat(32),
      },
      { db: database as never, now: () => new Date('2026-09-03T10:02:00.000Z') },
    );
    apps.push(app);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'correct horse battery staple' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/monitors/bulk-frequency',
      headers: { cookie: cookie ?? '' },
      payload: { monitorIds, intervalSeconds: 1_200 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updatedCount: 2 });
  });
});
