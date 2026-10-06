import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const gateway = (
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
).default;

function createEnvironment({ upstreamHandler, envOverrides } = {}) {
  const calls = [];
  const env = {
    APP_ORIGIN: 'https://uptime.internal',
    API: {
      fetch: async (request) => {
        calls.push(request);
        if (upstreamHandler) {
          return upstreamHandler(request);
        }
        return new Response('<h1>Status Page</h1>', {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': 'session=leaked; Path=/',
            'access-control-allow-credentials': 'true',
            location: 'https://evil.example.com',
            'x-custom-internal': 'secret',
          },
        });
      },
    },
    ...envOverrides,
  };
  return { env, calls };
}

test('rejects non-GET/HEAD methods with 405 Method Not Allowed', async () => {
  const { env, calls } = createEnvironment();

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const request = new Request('https://status.customer.com/', {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ a: 1 }),
    });

    const response = await gateway.fetch(request, env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  assert.equal(calls.length, 0);
});

test('rejects arbitrary paths other than / and /status.json with 404', async () => {
  const { env, calls } = createEnvironment();

  const rejectedPaths = [
    '/api/internal/secrets',
    '/favicon.ico',
    '/admin',
    '/status.json/extra',
    '/reports/public',
  ];

  for (const path of rejectedPaths) {
    const request = new Request(`https://status.customer.com${path}`, { method: 'GET' });
    const response = await gateway.fetch(request, env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  assert.equal(calls.length, 0);
});

test('strips Cookie, Authorization, and untrusted headers while forwarding safe headers', async () => {
  const { env, calls } = createEnvironment();

  const request = new Request('https://status.customer.com/', {
    method: 'GET',
    headers: {
      cookie: 'session=secret-token; tracking=123',
      authorization: 'Bearer secret-jwt',
      'x-uptime-workspace': 'ws-target',
      'x-forwarded-host': 'attacker.com',
      'x-custom-attack': 'malicious',
      'user-agent': 'Mozilla/5.0 TestAgent',
      accept: 'text/html',
      'accept-language': 'en-US',
    },
  });

  const response = await gateway.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);

  const forwarded = calls[0];
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(forwarded.headers.get('authorization'), null);
  assert.equal(forwarded.headers.get('x-uptime-workspace'), null);
  assert.equal(forwarded.headers.get('x-forwarded-host'), null);
  assert.equal(forwarded.headers.get('x-custom-attack'), null);

  assert.equal(forwarded.headers.get('user-agent'), 'Mozilla/5.0 TestAgent');
  assert.equal(forwarded.headers.get('accept'), 'text/html');
  assert.equal(forwarded.headers.get('accept-language'), 'en-US');
});

test('forwards / to upstream HTML route with authoritative encoded hostname and validated HTTPS origin', async () => {
  // Verifies that insecure APP_ORIGIN falls back to default https://uptime.internal
  const { env, calls } = createEnvironment({
    envOverrides: { APP_ORIGIN: 'http://insecure.internal' },
  });

  const request = new Request('https://status.acme-corp.com/', { method: 'GET' });
  const response = await gateway.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);

  const forwarded = calls[0];
  assert.equal(
    forwarded.url,
    'https://uptime.internal/api/public/custom-status/status.acme-corp.com',
  );
  assert.equal(forwarded.method, 'GET');
});

test('forwards /status.json to upstream snapshot route with authoritative encoded hostname', async () => {
  const { env, calls } = createEnvironment({
    upstreamHandler: async (req) => {
      assert.equal(
        req.url,
        'https://uptime.internal/api/public/custom-status/status.acme-corp.com/snapshot',
      );
      return new Response(JSON.stringify({ statusPage: { title: 'Acme Status' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const request = new Request('https://status.acme-corp.com/status.json', { method: 'GET' });
  const response = await gateway.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const data = await response.json();
  assert.equal(data.statusPage.title, 'Acme Status');
});

test('strips Set-Cookie, ACAC, Location redirect from upstream response and enforces Cache-Control: no-store', async () => {
  const { env } = createEnvironment({
    upstreamHandler: async () =>
      new Response('Redirecting', {
        status: 302,
        headers: {
          'set-cookie': 'session=injected; Secure',
          'access-control-allow-credentials': 'true',
          location: 'https://external-leak.com',
          'cache-control': 'public, max-age=3600',
        },
      }),
  });

  const request = new Request('https://status.customer.com/', { method: 'GET' });
  const response = await gateway.fetch(request, env);

  // Redirect is stripped to 502 Bad Gateway to prevent external open-redirect
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('supports HEAD requests by returning upstream headers without body', async () => {
  const { env, calls } = createEnvironment({
    upstreamHandler: async () =>
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      }),
  });

  const request = new Request('https://status.customer.com/', { method: 'HEAD' });
  const response = await gateway.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');

  const text = await response.text();
  assert.equal(text, '');
});

test('returns 404 when upstream returns 404 or throws', async () => {
  const { env: notFoundEnv } = createEnvironment({
    upstreamHandler: async () => new Response('Not Found', { status: 404 }),
  });

  const req1 = new Request('https://unclaimed.customer.com/', { method: 'GET' });
  const res1 = await gateway.fetch(req1, notFoundEnv);
  assert.equal(res1.status, 404);

  const { env: throwingEnv } = createEnvironment({
    upstreamHandler: async () => {
      throw new Error('Connection failed');
    },
  });

  const req2 = new Request('https://unclaimed.customer.com/', { method: 'GET' });
  const res2 = await gateway.fetch(req2, throwingEnv);
  assert.equal(res2.status, 404);
});
