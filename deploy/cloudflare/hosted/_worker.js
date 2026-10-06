const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60, stale-while-revalidate=30',
  'x-content-type-options': 'nosniff',
};

const REPORT_METHODS = new Set(['GET', 'HEAD']);
const PUBLIC_REFERENCE = /^[A-Za-z0-9.-]+$/;

function reportKey(pathname) {
  if (!pathname.startsWith('/reports/public/')) return null;
  const suffix = pathname.slice('/reports/'.length);
  if (!suffix || suffix.includes('..') || suffix.includes('\\')) return null;
  if (suffix === 'public/status-pages.json') return suffix;
  if (/^public\/(?:monitors|status-pages)\/[A-Za-z0-9.-]+\.json$/.test(suffix)) return suffix;
  return null;
}

function publicApiRoute(pathname) {
  const monitor = pathname.match(/^\/api\/monitors\/public\/([^/]+)(?:\/(uptime|latency))?$/);
  if (monitor && isSafeReference(monitor[1])) return true;

  const statusPage = pathname.match(/^\/api\/status-pages\/public\/([^/]+)$/);
  return Boolean(statusPage && isSafeReference(statusPage[1]));
}

function isSafeReference(reference) {
  return PUBLIC_REFERENCE.test(reference) && !reference.includes('..');
}

function publicReportResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function reportError(status, message, headers = {}) {
  return new Response(message, { status, headers });
}

async function cohortReport(request, env, pathname) {
  const pointerObject = await env.IMPORTED_REPORTS.get('public/cohort.json');
  if (!pointerObject) return null;

  const pointer = await pointerObject.json();
  if (!/^\d{13}$/.test(pointer?.generation ?? '')) {
    return reportError(404, 'Not Found');
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get('generation');
  if (requested && !/^\d{13}$/.test(requested)) {
    return reportError(404, 'Not Found');
  }

  const previous = Array.isArray(pointer.previousGenerations)
    ? pointer.previousGenerations.filter((generation) => /^\d{13}$/.test(generation))
    : [];
  const allowed = new Set([pointer.generation, ...previous]);
  if (requested && !allowed.has(requested) && Number(requested) >= Number(pointer.generation)) {
    return reportError(404, 'Not Found');
  }

  const generation = requested && allowed.has(requested) ? requested : pointer.generation;
  let key;
  if (pathname === '/reports/public/status-pages.json') {
    key = `public/cohorts/${generation}/status-pages.json`;
  } else {
    const page = pathname.match(/^\/reports\/public\/status-pages\/([^/]+)\.json$/);
    if (!page || !isSafeReference(page[1])) return reportError(404, 'Not Found');
    key = `public/cohorts/${generation}/status-pages/${page[1]}.json`;
  }

  const object = await env.IMPORTED_REPORTS.get(key);
  if (!object) return reportError(404, 'Not Found');

  const headers = new Headers(JSON_HEADERS);
  headers.set('cache-control', 'no-cache');
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function liveMonitorReport(request, env) {
  const url = new URL(request.url);
  // Monitor snapshots have their own generation, separate from status cohorts.
  url.searchParams.delete('generation');
  const forwarded = new Request(url, request);
  const response = await env.IMPORTED_REPORTER.fetch(forwarded);
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function apiRoute(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function oauthRoute(pathname) {
  return pathname === '/oauth' || pathname.startsWith('/oauth/');
}

function reportsRoute(pathname) {
  return pathname === '/reports' || pathname.startsWith('/reports/');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Workspace-bearing links always go through hosted authorization, including
    // empty workspace values and requests for otherwise imported public data.
    if (
      url.searchParams.has('workspace') &&
      (apiRoute(pathname) || oauthRoute(pathname) || reportsRoute(pathname))
    ) {
      return env.API.fetch(request);
    }

    if (oauthRoute(pathname)) return env.API.fetch(request);

    if (apiRoute(pathname)) {
      if (publicApiRoute(pathname)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return reportError(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
        }
        return (env.IMPORTED_API ?? env.API).fetch(request);
      }
      return env.API.fetch(request);
    }

    if (reportsRoute(pathname)) {
      if (!pathname.startsWith('/reports/public/')) return env.API.fetch(request);

      const key = reportKey(pathname);
      if (!REPORT_METHODS.has(request.method)) {
        return publicReportResponse(reportError(405, 'Method Not Allowed', { allow: 'GET, HEAD' }));
      }
      if (!key) return publicReportResponse(reportError(404, 'Not Found'));

      if (key.startsWith('public/monitors/')) {
        if (!env.IMPORTED_REPORTER) return env.API.fetch(request);
        return publicReportResponse(await liveMonitorReport(request, env));
      }

      if (!env.IMPORTED_REPORTS) return env.API.fetch(request);
      const cohort = await cohortReport(request, env, pathname);
      if (cohort) return publicReportResponse(cohort);

      const object = await env.IMPORTED_REPORTS.get(key);
      if (!object) return publicReportResponse(reportError(404, 'Not Found'));
      const headers = new Headers(JSON_HEADERS);
      if (object.httpEtag) headers.set('etag', object.httpEtag);
      return publicReportResponse(
        new Response(request.method === 'HEAD' ? null : object.body, { headers }),
      );
    }

    return env.ASSETS.fetch(request);
  },
};
