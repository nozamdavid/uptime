import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from './server.js';

const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('proxy trust', () => {
  it('trusts exactly the configured number of forwarding hops', async () => {
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD_HASH: await argon2.hash('correct horse battery staple', {
          type: argon2.argon2id,
        }),
        SESSION_SECRET: 'a'.repeat(32),
        API_TRUST_PROXY_HOPS: 1,
      },
      { db: { execute: async () => ({ rows: [] }) } as never },
    );
    apps.push(app);
    app.get('/test/request-ip', async (request) => ({ ip: request.ip, ips: request.ips }));

    const response = await app.inject({
      method: 'GET',
      url: '/test/request-ip',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.10' },
    });

    expect(response.json()).toEqual({
      ip: '198.51.100.10',
      ips: ['10.0.0.5', '198.51.100.10'],
    });
  });
});
