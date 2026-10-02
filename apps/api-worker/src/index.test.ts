import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from '@uptime/cloudflare';

import worker, { workerFetch } from './index.js';
import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';
import { defaultTestConfig } from './testing/harness.js';

const passwordHash = await hashPassword('correct horse battery staple');

const env = {
  DB: createD1Adapter(createTestDatabase()),
  ADMIN_EMAIL: defaultTestConfig.adminEmail,
  ADMIN_PASSWORD_HASH: passwordHash,
  SESSION_SECRET: 'a'.repeat(32),
  CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
  REGIONS_LIST: '',
  SESSION_TTL_SECONDS: '604800',
  SESSION_COOKIE_SECURE: 'false',
  ENVIRONMENT: 'test',
};

const context = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
  env.DB.close();
  env.DB = createD1Adapter(createTestDatabase());
});

describe('worker entry point', () => {
  it('wraps host fetch so property invocation cannot supply an illegal receiver', async () => {
    const fetchSpy = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const receiverSensitiveFetch = fetchSpy as unknown as typeof fetch;
    vi.stubGlobal('fetch', receiverSensitiveFetch);

    const unsafe = { fetchImpl: receiverSensitiveFetch };
    expect(() => unsafe.fetchImpl('https://hooks.example.test')).toThrow('Illegal invocation');
    fetchSpy.mockClear();

    const safe = { fetchImpl: workerFetch };
    const response = await safe.fetchImpl('https://hooks.example.test');
    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('seeds the admin and serves health', async () => {
    const response = await worker.fetch(new Request('https://api.test/health'), env, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('handles login, session and logout end to end', async () => {
    const login = await worker.fetch(
      new Request('https://api.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correct horse battery staple' }),
      }),
      env,
      context,
    );
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const session = await worker.fetch(
      new Request('https://api.test/api/auth/session', { headers: { cookie } }),
      env,
      context,
    );
    expect(session.status).toBe(200);

    const logout = await worker.fetch(
      new Request('https://api.test/api/auth/logout', { method: 'POST', headers: { cookie } }),
      env,
      context,
    );
    expect(logout.status).toBe(204);
  });

  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    const missing = await worker.fetch(new Request('https://api.test/nope'), env, context);
    expect(missing.status).toBe(404);
    const wrongMethod = await worker.fetch(
      new Request('https://api.test/api/auth/login', { method: 'GET' }),
      env,
      context,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it('rejects a cross-origin unsafe request', async () => {
    const response = await worker.fetch(
      new Request('https://api.test/api/estimates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ regionIds: ['us-east'], intervalSeconds: 300 }),
      }),
      env,
      context,
    );
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'origin_forbidden' },
    });
  });

  it('answers CORS preflight with configured headers', async () => {
    const response = await worker.fetch(
      new Request('https://api.test/api/regions', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      env,
      context,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
