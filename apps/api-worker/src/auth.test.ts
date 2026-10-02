import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestContext,
  login,
  request,
  seedMonitor,
  TEST_PASSWORD,
  type TestContext,
} from './testing/test-utils.js';
import { hashPassword } from '@uptime/cloudflare';
import { pruneExpiredSessions } from './auth.js';

const json = (response: Response): Promise<any> => response.json();

const contexts: TestContext[] = [];

async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

describe('auth routes', () => {
  it('rejects unauthenticated private requests', async () => {
    const { app } = await context();
    const response = await request(app, '/api/monitors');
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('unauthorized');
  });

  it('logs in with the seeded password and reports the session', async () => {
    const { app } = await context();
    const { response, cookie } = await login(app);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.admin.email).toBe('admin@example.com');
    expect(response.headers.get('set-cookie')).toContain('uptime_session=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');

    const session = await request(app, '/api/auth/session', { cookie });
    expect(session.status).toBe(200);
    expect((await json(session)).admin.email).toBe('admin@example.com');
  });

  it('rejects an incorrect password without creating a session', async () => {
    const { app } = await context();
    const { response } = await login(app, 'wrong password');
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('invalid_credentials');
  });

  it('clears the session on logout', async () => {
    const { app } = await context();
    const { cookie } = await login(app);
    const logout = await request(app, '/api/auth/logout', { method: 'POST', cookie });
    expect(logout.status).toBe(204);
    const session = await request(app, '/api/auth/session', { cookie });
    expect(session.status).toBe(401);
  });

  it('reports an auth configuration error for a malformed stored hash', async () => {
    const bcryptish = '$2b$10$abcdefghijklmnopqrstuv';
    const ctx = await createTestContext({ passwordHash: bcryptish });
    contexts.push(ctx);
    const response = await request(ctx.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(500);
    expect((await json(response)).error.code).toBe('auth_configuration_error');
  });

  it.each([
    [
      'an iteration count above the Worker limit',
      (hash: string) => hash.replace('$100000$', '$100001$'),
    ],
    ['an invalid salt length', (hash: string) => replaceHashPart(hash, 2, 'YQ')],
    ['an invalid key length', (hash: string) => replaceHashPart(hash, 3, 'YQ')],
  ])('reports an auth configuration error for %s', async (_label, mutate) => {
    const unsupportedHash = mutate(await hashPassword(TEST_PASSWORD));
    const ctx = await createTestContext({ passwordHash: unsupportedHash });
    contexts.push(ctx);
    const response = await request(ctx.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(500);
    expect((await json(response)).error.code).toBe('auth_configuration_error');
  });

  it('never leaks the password hash through the session response', async () => {
    const { app } = await context();
    const { cookie } = await login(app);
    const monitor = await request(app, '/api/monitors', { cookie });
    expect(monitor.status).toBe(200);
    expect(await monitor.text()).not.toContain('pbkdf2');
  });

  it('bounds opportunistic expired-session cleanup', async () => {
    const ctx = await context();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO sessions (id, admin_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, '00000000-0000-4000-8000-000000000001', ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 250; index += 1) {
      const timestamp = '2026-09-01T00:00:00.000Z';
      insert.run(`expired-${index}`, `hash-${index}`, timestamp, timestamp, timestamp);
    }
    await pruneExpiredSessions(ctx.db, new Date('2026-09-16T12:00:00.000Z'));
    const remaining = ctx.sqlite.prepare('SELECT count(*) AS count FROM sessions').get() as {
      count: number;
    };
    expect(remaining.count).toBe(150);
  });
});

function replaceHashPart(hash: string, index: number, replacement: string): string {
  const parts = hash.split('$');
  parts[index] = replacement;
  return parts.join('$');
}

describe('health and regions', () => {
  it('serves health without authentication', async () => {
    const { app } = await context();
    const response = await request(app, '/health');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'ok' });
  });

  it('returns the enabled region definitions', async () => {
    const { app } = await context();
    const response = await request(app, '/api/regions');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.regions).toHaveLength(9);
  });

  it('computes target checks per day', async () => {
    const { app } = await context();
    const response = await request(app, '/api/estimates', {
      method: 'POST',
      body: JSON.stringify({ regionIds: ['us-east', 'eu-west'], intervalSeconds: 300 }),
    });
    expect(await json(response)).toEqual({
      regionCount: 2,
      intervalSeconds: 300,
      targetChecksPerDay: 576,
      excludes: ['redirects', 'manual-checks'],
    });
  });
});

describe('monitor listing', () => {
  it('lists monitors with regions, status and target checks', async () => {
    const ctx = await context();
    seedMonitor(ctx.sqlite, { regions: ['us-east', 'eu-west'] });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/monitors', { cookie });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.monitors).toHaveLength(1);
    expect(body.monitors[0].monitor.regionIds).toEqual(['eu-west', 'us-east']);
    expect(body.monitors[0].status).toBe('unknown');
    expect(body.monitors[0].targetChecksPerDay).toBe(576);
  });
});
