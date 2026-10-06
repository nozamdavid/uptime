/**
 * Cloudflare for SaaS Fallback Origin Gateway Worker.
 *
 * Responsibilities:
 * - Authoritative hostname routing from request URL.
 * - Enforces read-only traffic (only GET and HEAD permitted).
 * - Restricts allowed routes strictly to "/" (HTML status page) and "/status.json" (JSON snapshot).
 * - Strips all credentials, session cookies, auth tokens, and untrusted forwarded headers.
 * - Dispatches securely via internal service binding API to /api/public/custom-status/:hostname.
 * - Guarantees Cache-Control: no-store, strips any Set-Cookie, Access-Control-Allow-Credentials, and redirects.
 */

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const SAFE_FORWARD_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
]);

const INTERNAL_ORIGIN_DEFAULT = 'https://uptime.internal';

function resolveTrustedAppOrigin(configured) {
  if (typeof configured === 'string' && configured.trim()) {
    try {
      const parsed = new URL(configured.trim());
      if (parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // Ignored
    }
  }
  return INTERNAL_ORIGIN_DEFAULT;
}

export default {
  async fetch(request, env) {
    const method = request.method;

    // 1. Strict method check: only GET and HEAD
    if (!ALLOWED_METHODS.has(method)) {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          allow: 'GET, HEAD',
          'cache-control': 'no-store',
        },
      });
    }

    const url = new URL(request.url);
    const { pathname, hostname } = url;

    // 2. Reject missing or localhost/invalid hostnames
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
      return notFoundResponse(method, false);
    }

    // 3. Strict route allowlist: only "/" and "/status.json"
    let upstreamSubpath;
    let isJson = false;

    if (pathname === '/' || pathname === '') {
      upstreamSubpath = '';
      isJson = false;
    } else if (pathname === '/status.json') {
      upstreamSubpath = '/snapshot';
      isJson = true;
    } else {
      return notFoundResponse(method, false);
    }

    // 4. Sanitize and prepare forwarded headers
    // Strip Cookie, Authorization, x-uptime-workspace, x-forwarded-host, etc.
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (SAFE_FORWARD_HEADERS.has(lower)) {
        forwardHeaders.set(key, value);
      }
    }

    // 5. Construct fixed internal origin destination (never use incoming hostname as fetch target)
    const baseOrigin = resolveTrustedAppOrigin(env.APP_ORIGIN);
    const internalUrl = new URL(
      `/api/public/custom-status/${encodeURIComponent(hostname)}${upstreamSubpath}`,
      baseOrigin,
    );

    const internalRequest = new Request(internalUrl.toString(), {
      method,
      headers: forwardHeaders,
      redirect: 'manual',
    });

    if (!env.API || typeof env.API.fetch !== 'function') {
      return new Response('Service Unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }

    // 6. Dispatch via service binding
    let response;
    try {
      response = await env.API.fetch(internalRequest);
    } catch {
      return notFoundResponse(method, isJson);
    }

    // 7. Sanitize outbound response headers
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.set('x-content-type-options', 'nosniff');
    responseHeaders.delete('set-cookie');
    responseHeaders.delete('access-control-allow-credentials');
    responseHeaders.delete('location');

    let status = response.status;
    let statusText = response.statusText;
    if (status >= 300 && status < 400) {
      status = 502;
      statusText = 'Bad Gateway';
    }

    return new Response(method === 'HEAD' ? null : response.body, {
      status,
      statusText,
      headers: responseHeaders,
    });
  },
};

function notFoundResponse(method, isJson) {
  if (isJson) {
    return new Response(
      method === 'HEAD'
        ? null
        : JSON.stringify({ error: { code: 'not_found', message: 'Status page not found' } }),
      {
        status: 404,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      },
    );
  }
  return new Response(
    method === 'HEAD'
      ? null
      : '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>',
    {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
