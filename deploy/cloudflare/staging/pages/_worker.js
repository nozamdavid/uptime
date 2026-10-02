const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60, stale-while-revalidate=30',
  'x-content-type-options': 'nosniff',
};

function reportKey(pathname) {
  if (!pathname.startsWith('/reports/public/')) return null;
  const suffix = pathname.slice('/reports/'.length);
  if (!suffix || suffix.includes('..') || suffix.includes('\\')) return null;
  if (suffix === 'public/status-pages.json') return suffix;
  if (/^public\/(?:monitors|status-pages)\/[A-Za-z0-9.-]+\.json$/.test(suffix)) return suffix;
  return null;
}

async function cohortReport(request, env, pathname) {
  const pointerObject = await env.REPORTS.get('public/cohort.json');
  if (!pointerObject) return null;
  const pointer = await pointerObject.json();
  const requested = new URL(request.url).searchParams.get('generation');
  if (requested && !/^\d{13}$/.test(requested)) return new Response('Not Found', { status: 404 });
  const allowed = new Set([pointer.generation, ...(pointer.previousGenerations ?? [])]);
  if (requested && !allowed.has(requested) && Number(requested) >= Number(pointer.generation))
    return new Response('Not Found', { status: 404 });
  const generation = requested && allowed.has(requested) ? requested : pointer.generation;
  let body;
  if (pathname === '/reports/public/status-pages.json') {
    body = await env.REPORTS.get(`public/cohorts/${generation}/status-pages.json`);
  } else {
    const page = pathname.match(/^\/reports\/public\/status-pages\/([^/]+)\.json$/);
    if (!page) return new Response('Not Found', { status: 404 });
    body = await env.REPORTS.get(`public/cohorts/${generation}/status-pages/${page[1]}.json`);
  }
  if (!body) return new Response('Not Found', { status: 404 });
  const headers = new Headers(JSON_HEADERS);
  headers.set('cache-control', 'no-cache');
  if (body.httpEtag) headers.set('etag', body.httpEtag);
  return new Response(request.method === 'HEAD' ? null : body.body, { headers });
}

function monitorReport(pathname) {
  return /^\/reports\/public\/monitors\/[A-Za-z0-9.-]+\.json$/.test(pathname);
}

// Public reports are fetched by static status pages on other origins.
function publicReportResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function liveMonitorReport(request, env) {
  const url = new URL(request.url);
  // Monitor snapshots have their own generation; a status-page cohort pin is
  // not meaningful for this independently refreshed endpoint.
  url.searchParams.delete('generation');
  const forwarded = new Request(url, request);
  const response = await env.REPORTER.fetch(forwarded);
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// AT Protocol OAuth and interest-signup routes live on a separate Worker so
// this gateway can keep serving the imported monitoring history from R2.
// Checked before the `/api/` prefix because the OAuth callback lives under it.
function oauthRoute(pathname, request) {
  if (pathname === '/oauth' || pathname.startsWith('/oauth/')) return true;
  if (pathname === '/api/auth/atproto' || pathname.startsWith('/api/auth/atproto/')) return true;
  if (pathname === '/api/interest' || pathname.startsWith('/api/interest/')) return true;
  if (pathname === '/api/operator' || pathname.startsWith('/api/operator/')) return true;
  if (pathname === '/api/auth/identity') return true;
  return (
    pathname === '/api/auth/logout' &&
    /(?:^|;\s*)uptime_atproto_session=/.test(request.headers.get('cookie') ?? '')
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (oauthRoute(url.pathname, request)) {
      return env.OAUTH.fetch(request);
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return env.API.fetch(request);
    }

    if (url.pathname.startsWith('/reports/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const response = new Response('Method Not Allowed', {
          status: 405,
          headers: { allow: 'GET, HEAD' },
        });
        return url.pathname.startsWith('/reports/public/')
          ? publicReportResponse(response)
          : response;
      }
      const key = reportKey(url.pathname);
      if (!key) {
        const response = new Response('Not Found', { status: 404 });
        return url.pathname.startsWith('/reports/public/')
          ? publicReportResponse(response)
          : response;
      }
      if (monitorReport(url.pathname)) {
        return publicReportResponse(await liveMonitorReport(request, env));
      }
      const cohort = await cohortReport(request, env, url.pathname);
      if (cohort) return publicReportResponse(cohort);
      const object = await env.REPORTS.get(key);
      if (!object) return publicReportResponse(new Response('Not Found', { status: 404 }));
      const headers = new Headers(JSON_HEADERS);
      if (object.httpEtag) headers.set('etag', object.httpEtag);
      return publicReportResponse(
        new Response(request.method === 'HEAD' ? null : object.body, { headers }),
      );
    }

    return env.ASSETS.fetch(request);
  },
};
