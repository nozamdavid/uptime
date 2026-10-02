import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const gateway = (
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
).default;

function environment({ object = null } = {}) {
  const calls = [];
  return {
    calls,
    env: {
      API: { fetch: async (request) => (calls.push(['api', request]), new Response('api')) },
      REPORTER: {
        fetch: async (request) => (calls.push(['reporter', request]), new Response('monitor')),
      },
      REPORTS: {
        get: async (key) => (calls.push(['r2', key]), key === 'public/cohort.json' ? null : object),
      },
      ASSETS: {
        fetch: async (request) => (calls.push(['assets', request]), new Response('asset')),
      },
    },
  };
}

test('forwards the original API request to the staging service binding', async () => {
  const { env, calls } = environment();
  const request = new Request('https://uptime-staging.pages.dev/api/auth/login', {
    method: 'POST',
    headers: { cookie: 'session=test', 'x-test': 'kept' },
    body: '{}',
  });
  assert.equal((await gateway.fetch(request, env)).status, 200);
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[0][1], request);
});

test('forwards monitor snapshots to the reporter without reading the cohort from R2', async () => {
  const { env, calls } = environment();
  const request = new Request(
    'https://uptime-staging.pages.dev/reports/public/monitors/demo.json?generation=old',
  );
  const response = await gateway.fetch(request, env);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['reporter'],
  );
  assert.equal(
    calls[0][1].url,
    'https://uptime-staging.pages.dev/reports/public/monitors/demo.json',
  );
  assert.equal(await response.text(), 'monitor');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('serves public status-page report keys with JSON caching headers', async () => {
  const object = { body: 'stream-body', httpEtag: '"etag"' };
  const { env, calls } = environment({ object });
  const response = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages/demo.json'),
    env,
  );
  assert.deepEqual(calls.slice(0, 2), [
    ['r2', 'public/cohort.json'],
    ['r2', 'public/status-pages/demo.json'],
  ]);
  assert.equal(await response.text(), 'stream-body');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('cache-control'), /^public/);
});

test('adds wildcard CORS only to public report responses, including errors', async () => {
  const { env } = environment({ object: { body: 'fallback' } });
  const report = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages/demo.json'),
    env,
  );
  assert.equal(report.headers.get('access-control-allow-origin'), '*');
  assert.equal(report.headers.get('access-control-allow-credentials'), null);

  const reporter = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/monitors/demo.json'),
    env,
  );
  assert.equal(reporter.headers.get('access-control-allow-origin'), '*');
  assert.equal(reporter.headers.get('access-control-allow-credentials'), null);

  const reporterFailureEnv = environment().env;
  reporterFailureEnv.REPORTER.fetch = async () => new Response('unavailable', { status: 503 });
  const reporterFailure = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/monitors/demo.json'),
    reporterFailureEnv,
  );
  assert.equal(reporterFailure.status, 503);
  assert.equal(reporterFailure.headers.get('access-control-allow-origin'), '*');

  const missing = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages/missing.json'),
    environment().env,
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');

  const methodError = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages.json', {
      method: 'POST',
    }),
    environment().env,
  );
  assert.equal(methodError.status, 405);
  assert.equal(methodError.headers.get('access-control-allow-origin'), '*');

  const api = await gateway.fetch(new Request('https://uptime-staging.pages.dev/api/health'), env);
  assert.equal(api.headers.get('access-control-allow-origin'), null);
  const asset = await gateway.fetch(new Request('https://uptime-staging.pages.dev/monitors'), env);
  assert.equal(asset.headers.get('access-control-allow-origin'), null);
});

test('HEAD omits the report body and disallowed methods never read R2', async () => {
  const { env, calls } = environment({ object: { body: 'secret' } });
  const head = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages.json', {
      method: 'HEAD',
    }),
    env,
  );
  assert.equal(await head.text(), '');
  const post = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/status-pages.json', {
      method: 'POST',
    }),
    env,
  );
  assert.equal(post.status, 405);
  assert.equal(calls.filter(([kind]) => kind === 'r2').length, 2);
});

test('rejects non-public report paths and sends application routes to assets', async () => {
  const { env, calls } = environment();
  assert.equal(
    (await gateway.fetch(new Request('https://uptime-staging.pages.dev/reports/private/x'), env))
      .status,
    404,
  );
  assert.equal(
    (await gateway.fetch(new Request('https://uptime-staging.pages.dev/monitors'), env)).status,
    200,
  );
  assert.equal(calls.at(-1)[0], 'assets');
});

test('HEAD monitor requests forward to the reporter and method constraints prevent service calls', async () => {
  const { env, calls } = environment();
  const head = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/monitors/demo.json', {
      method: 'HEAD',
    }),
    env,
  );
  assert.equal(await head.text(), '');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['reporter'],
  );

  const before = calls.length;
  const post = await gateway.fetch(
    new Request('https://uptime-staging.pages.dev/reports/public/monitors/demo.json', {
      method: 'POST',
    }),
    env,
  );
  assert.equal(post.status, 405);
  assert.equal(calls.length, before);
});

test('status-page reports and index remain pinned to one atomic cohort generation', async () => {
  const calls = [];
  const pointer = {
    generation: '1789992000000',
    previousGenerations: ['1789991940000'],
  };
  const object = (value) => ({
    body: JSON.stringify(value),
    httpEtag: '"cohort"',
    json: async () => value,
  });
  const env = {
    API: { fetch: async () => new Response('api') },
    ASSETS: { fetch: async () => new Response('asset') },
    REPORTS: {
      get: async (key) => {
        calls.push(key);
        if (key === 'public/cohort.json') return object(pointer);
        return object({ generation: key.split('/')[2], statusPages: [] });
      },
    },
  };
  const retained = await gateway.fetch(
    new Request(
      'https://uptime-staging.pages.dev/reports/public/status-pages.json?generation=1789991940000',
    ),
    env,
  );
  assert.equal(retained.headers.get('access-control-allow-origin'), '*');
  assert.equal((await retained.json()).generation, '1789991940000');
  const retainedPage = await gateway.fetch(
    new Request(
      'https://uptime-staging.pages.dev/reports/public/status-pages/demo.json?generation=1789991940000',
    ),
    env,
  );
  assert.equal((await retainedPage.json()).generation, '1789991940000');
  const expired = await gateway.fetch(
    new Request(
      'https://uptime-staging.pages.dev/reports/public/status-pages.json?generation=1789991880000',
    ),
    env,
  );
  assert.equal((await expired.json()).generation, pointer.generation);
  const malformed = await gateway.fetch(
    new Request(
      'https://uptime-staging.pages.dev/reports/public/status-pages.json?generation=../../bad',
    ),
    env,
  );
  assert.equal(malformed.status, 404);
  const unknownFuture = await gateway.fetch(
    new Request(
      'https://uptime-staging.pages.dev/reports/public/status-pages.json?generation=1799992000000',
    ),
    env,
  );
  assert.equal(unknownFuture.status, 404);
  assert.deepEqual(calls, [
    'public/cohort.json',
    'public/cohorts/1789991940000/status-pages.json',
    'public/cohort.json',
    'public/cohorts/1789991940000/status-pages/demo.json',
    'public/cohort.json',
    'public/cohorts/1789992000000/status-pages.json',
    'public/cohort.json',
    'public/cohort.json',
  ]);
});

test('monitor references rejected by the allowlist never reach the reporter or R2', async () => {
  const calls = [];
  const env = {
    REPORTER: { fetch: async () => assert.fail('invalid monitor path forwarded') },
    REPORTS: { get: async (key) => (calls.push(key), null) },
  };
  const response = await gateway.fetch(
    new Request(
      `https://uptime-staging.pages.dev/reports/public/monitors/${encodeURIComponent('bad ref')}.json`,
    ),
    env,
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});
