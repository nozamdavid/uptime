import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const gateway = (
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
).default;

function storedObject(body, httpEtag) {
  return {
    body,
    httpEtag,
    json: async () => JSON.parse(body),
  };
}

function environment({ imports = false, reportObjects = new Map() } = {}) {
  const calls = [];
  const env = {
    API: {
      fetch: async (request) => (calls.push(['api', request]), new Response('api')),
    },
    ASSETS: {
      fetch: async (request) => (calls.push(['assets', request]), new Response('asset')),
    },
  };

  if (imports) {
    env.IMPORTED_API = {
      fetch: async (request) => (
        calls.push(['imported-api', request]),
        new Response('imported api')
      ),
    };
    env.IMPORTED_REPORTER = {
      fetch: async (request) => (calls.push(['reporter', request]), new Response('monitor')),
    };
    env.IMPORTED_REPORTS = {
      get: async (key) => (calls.push(['r2', key]), reportObjects.get(key) ?? null),
    };
  }

  return { env, calls };
}

test('forwards private API and OAuth requests unchanged to the hosted API', async () => {
  const { env, calls } = environment();
  const requests = [
    new Request('https://uptime.noz.am/api/workspace/usage?workspace=abc', {
      method: 'POST',
      headers: { cookie: 'session=secret', 'x-test': 'kept', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }),
    new Request('https://uptime.noz.am/oauth/callback?code=abc&state=xyz', {
      method: 'GET',
      headers: { cookie: 'oauth=session' },
    }),
    new Request('https://uptime.noz.am/api/operator/slots?workspace=', {
      headers: { cookie: 'session=operator' },
    }),
  ];

  for (const request of requests) {
    assert.equal((await gateway.fetch(request, env)).status, 200);
  }

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api', 'api', 'api'],
  );
  assert.equal(calls[0][1].url, requests[0].url);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.get('cookie'), 'session=secret');
  assert.equal(calls[0][1].headers.get('x-test'), 'kept');
  assert.deepEqual(await calls[0][1].clone().json(), { enabled: true });
  assert.equal(calls[1][1].url, requests[1].url);
  assert.equal(calls[1][1].headers.get('cookie'), 'oauth=session');
  assert.equal(calls[2][1].url, requests[2].url);
});

test('workspace query presence keeps every public-looking route on hosted authorization', async () => {
  const { env, calls } = environment({ imports: true });
  const requests = [
    new Request('https://uptime.noz.am/api/monitors/public/demo?workspace='),
    new Request('https://uptime.noz.am/api/status-pages/public/demo?workspace=invalid'),
    new Request('https://uptime.noz.am/reports/public/monitors/demo.json?workspace='),
    new Request('https://uptime.noz.am/reports/public/status-pages.json?workspace=invalid'),
  ];

  for (const request of requests) {
    assert.equal(await (await gateway.fetch(request, env)).text(), 'api');
  }

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api', 'api', 'api', 'api'],
  );
  assert.ok(calls.every(([, request]) => requests.includes(request)));
});

test('sends only exact public API routes to the optional imported API', async () => {
  const { env, calls } = environment({ imports: true });
  const routes = [
    '/api/monitors/public/demo',
    '/api/monitors/public/demo/uptime?range=30d',
    '/api/monitors/public/demo/latency?range=24h',
    '/api/status-pages/public/system.status',
  ];

  for (const route of routes) {
    const request = new Request(`https://uptime.noz.am${route}`);
    assert.equal(await (await gateway.fetch(request, env)).text(), 'imported api');
  }

  assert.deepEqual(
    calls.map(([kind]) => kind),
    routes.map(() => 'imported-api'),
  );
  assert.equal(calls[0][1].url, 'https://uptime.noz.am/api/monitors/public/demo');
  assert.equal(calls[1][1].url, 'https://uptime.noz.am/api/monitors/public/demo/uptime?range=30d');
});

test('keeps unknown public API paths on the hosted API', async () => {
  const { env, calls } = environment({ imports: true });

  for (const path of [
    '/api/monitors/public/demo/admin',
    '/api/monitors/public/a..b',
    '/api/status-pages/public/demo/export',
  ]) {
    await gateway.fetch(new Request(`https://uptime.noz.am${path}`), env);
  }

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api', 'api', 'api'],
  );
});

test('falls back to the hosted API when optional public API and report bindings are absent', async () => {
  const { env, calls } = environment();
  const routes = [
    '/api/monitors/public/demo',
    '/reports/public/monitors/demo.json',
    '/reports/public/status-pages/demo.json',
  ];

  for (const route of routes) {
    assert.equal(
      await (await gateway.fetch(new Request(`https://uptime.noz.am${route}`), env)).text(),
      'api',
    );
  }

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api', 'api', 'api'],
  );
});

test('keeps private reports and application routes on their existing bindings', async () => {
  const { env, calls } = environment({ imports: true });
  const privateReport = new Request('https://uptime.noz.am/reports/private/export?workspace=abc');
  const noWorkspaceReport = new Request('https://uptime.noz.am/reports/private/export');
  const applicationRoute = new Request('https://uptime.noz.am/app');

  assert.equal(await (await gateway.fetch(privateReport, env)).text(), 'api');
  assert.equal(await (await gateway.fetch(noWorkspaceReport, env)).text(), 'api');
  assert.equal(await (await gateway.fetch(applicationRoute, env)).text(), 'asset');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['api', 'api', 'assets'],
  );
});

test('routes public monitor reports through the reporter and removes cohort generation', async () => {
  const { env, calls } = environment({ imports: true });
  const request = new Request(
    'https://uptime.noz.am/reports/public/monitors/demo.json?generation=1789992000000&format=full',
  );
  const response = await gateway.fetch(request, env);

  assert.equal(await response.text(), 'monitor');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['reporter'],
  );
  assert.equal(
    calls[0][1].url,
    'https://uptime.noz.am/reports/public/monitors/demo.json?format=full',
  );
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('public monitor report HEAD omits the body and has CORS headers', async () => {
  const { env, calls } = environment({ imports: true });
  const response = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/monitors/demo.json', { method: 'HEAD' }),
    env,
  );

  assert.equal(await response.text(), '');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['reporter'],
  );
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('adds CORS to reporter failures and missing public status reports', async () => {
  const { env } = environment({ imports: true });
  env.IMPORTED_REPORTER.fetch = async () => new Response('unavailable', { status: 503 });

  const reporterFailure = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/monitors/demo.json'),
    env,
  );
  const missing = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages/missing.json'),
    env,
  );

  assert.equal(reporterFailure.status, 503);
  assert.equal(reporterFailure.headers.get('access-control-allow-origin'), '*');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');
});

test('serves legacy status-page reports from the imported reports bucket', async () => {
  const report = storedObject('{"statusPage":"demo"}', '"etag"');
  const reportObjects = new Map([['public/status-pages/demo.json', report]]);
  const { env, calls } = environment({ imports: true, reportObjects });
  const response = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages/demo.json'),
    env,
  );

  assert.deepEqual(calls, [
    ['r2', 'public/cohort.json'],
    ['r2', 'public/status-pages/demo.json'],
  ]);
  assert.deepEqual(await response.json(), { statusPage: 'demo' });
  assert.equal(response.headers.get('etag'), '"etag"');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('cache-control'), /^public/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('status-page report HEAD omits the body and rejected methods do not read R2', async () => {
  const report = storedObject('{"statusPage":"demo"}', '"etag"');
  const reportObjects = new Map([['public/status-pages/demo.json', report]]);
  const { env, calls } = environment({ imports: true, reportObjects });
  const head = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages/demo.json', {
      method: 'HEAD',
    }),
    env,
  );
  const readsAfterHead = calls.length;
  const post = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages/demo.json', {
      method: 'POST',
    }),
    env,
  );

  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('etag'), '"etag"');
  assert.equal(head.headers.get('access-control-allow-origin'), '*');
  assert.equal(post.status, 405);
  assert.equal(calls.length, readsAfterHead);
});

test('pins status-page index and page reports to the selected retained cohort generation', async () => {
  const pointer = storedObject(
    JSON.stringify({ generation: '1789992000000', previousGenerations: ['1789991940000'] }),
  );
  const calls = [];
  const env = {
    API: { fetch: async (request) => (calls.push(['api', request]), new Response('api')) },
    ASSETS: { fetch: async (request) => (calls.push(['assets', request]), new Response('asset')) },
    IMPORTED_REPORTS: {
      get: async (key) => {
        calls.push(['r2', key]);
        if (key === 'public/cohort.json') return pointer;
        return storedObject(JSON.stringify({ generation: key.split('/')[2] }));
      },
    },
  };

  const index = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages.json?generation=1789991940000'),
    env,
  );
  const page = await gateway.fetch(
    new Request(
      'https://uptime.noz.am/reports/public/status-pages/demo.json?generation=1789991940000',
    ),
    env,
  );
  const expired = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages.json?generation=1789991880000'),
    env,
  );

  assert.deepEqual(await index.json(), { generation: '1789991940000' });
  assert.deepEqual(await page.json(), { generation: '1789991940000' });
  assert.deepEqual(await expired.json(), { generation: '1789992000000' });
  assert.deepEqual(
    calls.map(([, key]) => key),
    [
      'public/cohort.json',
      'public/cohorts/1789991940000/status-pages.json',
      'public/cohort.json',
      'public/cohorts/1789991940000/status-pages/demo.json',
      'public/cohort.json',
      'public/cohorts/1789992000000/status-pages.json',
    ],
  );
});

test('rejects malformed and future cohort generations without reading arbitrary report keys', async () => {
  const calls = [];
  const env = {
    API: { fetch: async (request) => (calls.push(['api', request]), new Response('api')) },
    ASSETS: { fetch: async (request) => (calls.push(['assets', request]), new Response('asset')) },
    IMPORTED_REPORTS: {
      get: async (key) => {
        calls.push(['r2', key]);
        return key === 'public/cohort.json'
          ? storedObject(JSON.stringify({ generation: '1789992000000' }))
          : storedObject('{}');
      },
    },
  };

  for (const generation of ['../../bad', '1799992000000']) {
    const response = await gateway.fetch(
      new Request(
        `https://uptime.noz.am/reports/public/status-pages.json?generation=${encodeURIComponent(generation)}`,
      ),
      env,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }

  assert.deepEqual(calls, [
    ['r2', 'public/cohort.json'],
    ['r2', 'public/cohort.json'],
  ]);
});

test('rejects invalid public report paths and methods without touching legacy services', async () => {
  const { env, calls } = environment({ imports: true });
  const invalidPaths = [
    '/reports/public/other/demo.json',
    '/reports/public/status-pages/a..b.json',
    '/reports/public/status-pages/%2e%2e%2fsecret.json',
    '/reports/public/status-pages/nested/demo.json',
  ];

  for (const path of invalidPaths) {
    const response = await gateway.fetch(new Request(`https://uptime.noz.am${path}`), env);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }

  const method = await gateway.fetch(
    new Request('https://uptime.noz.am/reports/public/status-pages/demo.json', {
      method: 'POST',
    }),
    env,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, HEAD');
  assert.equal(method.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(calls, []);
});

test('rejects writes to exact imported public API routes', async () => {
  const { env, calls } = environment({ imports: true });
  const response = await gateway.fetch(
    new Request('https://uptime.noz.am/api/monitors/public/demo', {
      method: 'POST',
      body: '{}',
    }),
    env,
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(calls, []);
});

test('keeps the production Pages project and hosted bindings in the config', async () => {
  const config = await readFile(new URL('./pages.wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /^name = "uptime"$/m);
  assert.match(config, /uptime\.noz\.am/);
  assert.match(config, /binding = "API"\s+service = "uptime-hosted-api"/);
  assert.match(config, /binding = "IMPORTED_API"\s+service = "uptime-api"/);
  assert.match(config, /binding = "IMPORTED_REPORTER"\s+service = "uptime-reporter"/);
  assert.match(config, /binding = "IMPORTED_REPORTS"\s+bucket_name = "uptime-reports"/);
});
