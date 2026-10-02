import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from './server.js';

const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('enabled regions', () => {
  it('exposes only REGIONS_LIST entries in configured order', async () => {
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        REGIONS_LIST: 'asia-east,asia-south',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD_HASH: await argon2.hash('correct horse battery staple', {
          type: argon2.argon2id,
        }),
        SESSION_SECRET: 'a'.repeat(32),
      },
      { db: { execute: async () => ({ rows: [] }) } as never },
    );
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/regions' });

    expect(response.statusCode).toBe(200);
    expect(response.json().regions.map((region: { id: string }) => region.id)).toEqual([
      'asia-east',
      'asia-south',
    ]);
  });
});
