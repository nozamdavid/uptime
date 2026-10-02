import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const gateway = (
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
).default;

function environment() {
  const calls = [];
  return {
    calls,
    env: {
      API: { fetch: async (request) => (calls.push(['api', request]), new Response('api')) },
      ASSETS: {
        fetch: async (request) => (calls.push(['assets', request]), new Response('asset')),
      },
      REPORTS: { get: async () => assert.fail('hosted gateway must not read REPORTS directly') },
    },
  };
}

test('proxies API and OAuth requests unchanged, including method, body, cookies, and query', async () => {
  const { env, calls } = environment();
  const requests = [
    new Request('https://uptime.example/api/workspace/usage?workspace=abc', {
      method: 'POST',
      headers: { cookie: 'session=secret', 'x-test': 'kept', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }),
    new Request('https://uptime.example/oauth/callback?code=abc&state=xyz', {
      method: 'GET',
      headers: { cookie: 'oauth=session' },
    }),
  ];
  for (const request of requests) {
    const response = await gateway.fetch(request, env);
    assert.equal(response.status, 200);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].url, requests[0].url);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.get('cookie'), 'session=secret');
  assert.equal(calls[0][1].headers.get('x-test'), 'kept');
  assert.deepEqual(await calls[0][1].clone().json(), { enabled: true });
  assert.equal(calls[1][1].url, requests[1].url);
  assert.equal(calls[1][1].headers.get('cookie'), 'oauth=session');
});

test('proxies reports through the API binding without reading a reports bucket', async () => {
  const { env, calls } = environment();
  const request = new Request(
    'https://uptime.example/reports/public/status-pages/demo.json?workspace=abc',
  );
  const response = await gateway.fetch(request, env);
  assert.equal(await response.text(), 'api');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api'],
  );
  assert.equal(calls[0][1].url, request.url);
  assert.equal(calls[0][1].url.includes('workspace=abc'), true);
});

test('falls back to the asset binding for application routes', async () => {
  const { env, calls } = environment();
  const response = await gateway.fetch(new Request('https://uptime.example/app'), env);
  assert.equal(await response.text(), 'asset');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['assets'],
  );
});
