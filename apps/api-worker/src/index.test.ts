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
  delete (env as Record<string, unknown>).OAUTH;
  env.ENVIRONMENT = 'test';
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

  it('bridges an AT Protocol operator into a legacy product session and private history', async () => {
    const cookie = 'uptime_atproto_session=opaque-token';
    const fetchIdentity = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/api/auth/identity');
      expect(request.headers.get('cookie')).toBe(cookie);
      return Response.json({
        user: { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'operator.test' },
        isOperator: true,
      });
    });
    (env as Record<string, unknown>).OAUTH = { fetch: fetchIdentity };

    const session = await worker.fetch(
      new Request('https://api.test/api/auth/session', { headers: { cookie } }),
      env,
      context,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      user: { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'operator.test' },
      role: 'owner',
      isOperator: true,
      admin: {
        id: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
        did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
        handle: 'operator.test',
      },
    });

    const monitors = await worker.fetch(
      new Request('https://api.test/api/monitors', { headers: { cookie } }),
      env,
      context,
    );
    expect(monitors.status).toBe(200);
    expect(fetchIdentity).toHaveBeenCalledTimes(2);
  });

  it('bridges an imported staging workspace for private monitors without granting operator access', async () => {
    env.ENVIRONMENT = 'staging';
    const cookie = 'uptime_atproto_session=opaque-token';
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const fetchIdentity = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/api/auth/imported-identity');
      expect(request.headers.get('cookie')).toBe(cookie);
      expect(request.headers.get('x-uptime-workspace')).toBe(workspaceId);
      return Response.json({
        user: { did: 'did:plc:cccccccccccccccccccccccc', handle: 'imported.test' },
        importedWorkspaceId: workspaceId,
        role: 'owner',
      });
    });
    (env as Record<string, unknown>).OAUTH = { fetch: fetchIdentity };

    const session = await worker.fetch(
      new Request('https://api.test/api/auth/session', {
        headers: { cookie, 'x-uptime-workspace': workspaceId },
      }),
      env,
      context,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { did: 'did:plc:cccccccccccccccccccccccc', handle: 'imported.test' },
      isOperator: false,
    });

    const monitors = await worker.fetch(
      new Request('https://api.test/api/monitors', {
        headers: { cookie, 'x-uptime-workspace': workspaceId },
      }),
      env,
      context,
    );
    expect(monitors.status).toBe(200);
    expect(fetchIdentity).toHaveBeenCalledTimes(2);
  });

  it('rejects an imported identity workspace mismatch and never uses the imported bridge in production', async () => {
    const cookie = 'uptime_atproto_session=opaque-token';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const fetchIdentity = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/api/auth/imported-identity');
      return Response.json({
        user: { did: 'did:plc:dddddddddddddddddddddddd', handle: 'wrong.test' },
        importedWorkspaceId: '33333333-3333-4333-8333-333333333333',
        role: 'owner',
      });
    });
    env.ENVIRONMENT = 'staging';
    (env as Record<string, unknown>).OAUTH = { fetch: fetchIdentity };
    const mismatch = await worker.fetch(
      new Request('https://api.test/api/monitors', {
        headers: { cookie, 'x-uptime-workspace': workspaceId },
      }),
      env,
      context,
    );
    expect(mismatch.status).toBe(403);

    env.ENVIRONMENT = 'production';
    const operatorFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/api/auth/identity');
      return Response.json({
        user: { did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee', handle: 'operator.test' },
        isOperator: true,
      });
    });
    (env as Record<string, unknown>).OAUTH = { fetch: operatorFetch };
    const production = await worker.fetch(
      new Request('https://api.test/api/monitors', {
        headers: { cookie, 'x-uptime-workspace': workspaceId },
      }),
      env,
      context,
    );
    expect(production.status).toBe(200);
    expect(operatorFetch).toHaveBeenCalledOnce();
  });

  it('rejects nonoperators and malformed identity responses without trusting headers', async () => {
    const cookie = 'uptime_atproto_session=opaque-token';
    (env as Record<string, unknown>).OAUTH = {
      fetch: vi.fn(async () =>
        Response.json({
          user: { did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: 'user.test' },
          isOperator: false,
        }),
      ),
    };
    const response = await worker.fetch(
      new Request('https://api.test/api/auth/session', {
        headers: {
          cookie,
          'x-uptime-principal': JSON.stringify({
            id: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
            did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
            handle: 'operator.test',
          }),
        },
      }),
      env,
      context,
    );
    expect(response.status).toBe(403);

    const privateResponse = await worker.fetch(
      new Request('https://api.test/api/monitors', { headers: { cookie } }),
      env,
      context,
    );
    expect(privateResponse.status).toBe(403);

    const publicResponse = await worker.fetch(
      new Request('https://api.test/api/regions', { headers: { cookie } }),
      env,
      context,
    );
    expect(publicResponse.status).toBe(200);

    (env as Record<string, unknown>).OAUTH = {
      fetch: vi.fn(async () => Response.json(null)),
    };
    const malformed = await worker.fetch(
      new Request('https://api.test/api/auth/session', { headers: { cookie } }),
      env,
      context,
    );
    expect(malformed.status).toBe(401);
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
