import { describe, expect, it, vi } from 'vitest';

import proxyWorker, {
  type Env,
  type ExecutionContext,
  type Fetcher,
  type ScheduledController,
} from './index.js';

describe('VPS API Proxy Worker', () => {
  const dummyToken = 'a'.repeat(32);

  function createMockVpcService(
    responseFactory: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    return {
      fetch: vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const urlStr = typeof input === 'string' ? input : input.toString();
          return responseFactory(urlStr, init);
        },
      ),
    } as unknown as Fetcher;
  }

  it('forwards request method, path, search params, and body to STAGING_NODE_API', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const mockVpc = createMockVpcService(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
      PUBLIC_ORIGIN: 'https://uptime-staging.pages.dev',
    };

    const request = new Request('https://uptime-staging.pages.dev/api/monitors?page=2&limit=10', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.195',
      },
      body: JSON.stringify({ name: 'test monitor' }),
    });

    const response = await proxyWorker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(capturedUrl).toBe('http://127.0.0.1:3001/api/monitors?page=2&limit=10');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.redirect).toBe('manual');

    const forwardedHeaders = new Headers(capturedInit?.headers);
    expect(forwardedHeaders.get('cf-connecting-ip')).toBe('203.0.113.195');
    expect(forwardedHeaders.get('x-forwarded-host')).toBe('uptime-staging.pages.dev');
    expect(forwardedHeaders.get('x-forwarded-proto')).toBe('https');
    expect(forwardedHeaders.get('x-uptime-gateway-token')).toBe(dummyToken);
    expect(forwardedHeaders.get('x-gateway-token')).toBe(dummyToken);
  });

  it('strips client-supplied gateway tokens to prevent header spoofing', async () => {
    let capturedHeaders: Headers | undefined;

    const mockVpc = createMockVpcService(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response('ok', { status: 200 });
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
    };

    const request = new Request('https://uptime-staging.pages.dev/api/data', {
      method: 'GET',
      headers: {
        'x-uptime-gateway-token': 'attacker-forged-token',
        'x-gateway-token': 'attacker-forged-token-2',
      },
    });

    await proxyWorker.fetch(request, env);

    expect(capturedHeaders?.get('x-uptime-gateway-token')).toBe(dummyToken);
    expect(capturedHeaders?.get('x-gateway-token')).toBe(dummyToken);
  });

  it('strips hop-by-hop headers from incoming request and response', async () => {
    let capturedHeaders: Headers | undefined;

    const mockVpc = createMockVpcService(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response('ok', {
        status: 200,
        headers: {
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'x-custom-res': 'preserved',
        },
      });
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
    };

    const request = new Request('https://uptime-staging.pages.dev/api/data', {
      method: 'GET',
      headers: {
        connection: 'close',
        upgrade: 'websocket',
        'x-custom-req': 'preserved',
      },
    });

    const response = await proxyWorker.fetch(request, env);

    expect(capturedHeaders?.has('connection')).toBe(false);
    expect(capturedHeaders?.has('upgrade')).toBe(false);
    expect(capturedHeaders?.get('x-custom-req')).toBe('preserved');

    expect(response.headers.has('connection')).toBe(false);
    expect(response.headers.has('keep-alive')).toBe(false);
    expect(response.headers.get('x-custom-res')).toBe('preserved');
  });

  it('preserves manual redirects with Location header intact', async () => {
    const mockVpc = createMockVpcService(async () => {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://bsky.social/oauth/authorize?client_id=xyz',
          'set-cookie': 'uptime_atproto_login=state123; HttpOnly; SameSite=Lax',
        },
      });
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
    };

    const request = new Request('https://uptime-staging.pages.dev/oauth/login', {
      method: 'GET',
    });

    const response = await proxyWorker.fetch(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://bsky.social/oauth/authorize?client_id=xyz',
    );
    expect(response.headers.get('set-cookie')).toContain('uptime_atproto_login=state123');
  });

  it('preserves multiple Set-Cookie headers from upstream', async () => {
    const mockVpc = createMockVpcService(async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'cookie_a=val_a; Path=/; HttpOnly');
      headers.append('set-cookie', 'cookie_b=val_b; Path=/; Secure');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      });
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
    };

    const request = new Request('https://uptime-staging.pages.dev/api/auth/login', {
      method: 'POST',
    });

    const response = await proxyWorker.fetch(request, env);

    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe('cookie_a=val_a; Path=/; HttpOnly');
    expect(cookies[1]).toBe('cookie_b=val_b; Path=/; Secure');
  });

  it('returns clean 502 Bad Gateway without leaking internal errors when VPC fetch fails', async () => {
    const mockVpc = createMockVpcService(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3001 secret_internal_db_info');
    });

    const env: Env = {
      STAGING_NODE_API: mockVpc,
      API_GATEWAY_TOKEN: dummyToken,
    };

    const request = new Request('https://uptime-staging.pages.dev/api/monitors', {
      method: 'GET',
    });

    const response = await proxyWorker.fetch(request, env);

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toBe('Upstream API service temporarily unavailable');
    // Ensure internal error strings / secrets are NOT exposed
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('secret_internal_db_info');
  });

  it('returns 500 when STAGING_NODE_API is unconfigured', async () => {
    const env: Env = {};
    const request = new Request('https://uptime-staging.pages.dev/api/health');
    const response = await proxyWorker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('configuration_error');
  });

  it('completes scheduled handler without throwing', async () => {
    const env: Env = {
      STAGING_NODE_API: createMockVpcService(async () => new Response('ok')),
    };
    const controller = {
      cron: '* * * * *',
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController;
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await expect(proxyWorker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
  });
});
