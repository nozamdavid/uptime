import type { CloudflareEnv } from '@uptime/cloudflare';

import { createApiRouter, type AppEnv, type LogSink } from './app.js';
import { ensureAdmin, pruneExpiredSessions } from './auth.js';
import {
  IsolateRateLimiter,
  assertRequestOrigin,
  clientAddress,
  corsHeaders,
  errorResponse,
  HttpErrorLike,
} from './http.js';
import { parseApiEnv } from './env.js';
import { UrlPolicyError } from './security.js';

/** Rate-limit budgets for login, notification tests, and public endpoints. */
const loginRateLimit = { max: 8, windowSeconds: 60 };
const testRateLimit = { max: 5, windowSeconds: 60 };
const publicRateLimit = { max: 30, windowSeconds: 60 };

const limiter = new IsolateRateLimiter();

const log: LogSink = {
  warn: (bindings, message) => console.warn(message, bindings),
  error: (bindings, message) => console.error(message, bindings),
};

/** Keep host fetch receiver-neutral before passing it through app dependencies. */
export const workerFetch: typeof fetch = (input, init) => fetch(input, init);

const router = createApiRouter({ log, notificationFetch: workerFetch });

/**
 * Cloudflare API Worker.
 *
 * SECURITY NOTES
 * - State-changing requests are checked against `WEB_ORIGIN`/`ALLOWED_ORIGINS`;
 *   with no allowlist configured, same-origin is derived from the request URL.
 * - Cookies are `HttpOnly` + `SameSite` (+ `Secure` in production). The Node
 *   API's proxy-trust setting is gone: Workers always see the Cloudflare client
 *   address via `CF-Connecting-IP`.
 * - Rate limiting is per-isolate best effort (see `IsolateRateLimiter`); add a
 *   Cloudflare Rate Limiting rule for real distribution.
 *
 * LIMITATIONS
 * - Argon2 password hashes cannot be verified in Workers. Only PBKDF2 PHC
 *   hashes are accepted (see `auth.ts`).
 * - SMTP delivery is unsupported (see `providers.ts`).
 */
export default {
  async fetch(request: Request, env: CloudflareEnv, context: ExecutionContext): Promise<Response> {
    let config;
    try {
      config = parseApiEnv(env);
    } catch (error) {
      console.error('Invalid API Worker configuration', error);
      return errorResponse(500, 'internal_error', 'Worker configuration is invalid');
    }

    const db = env.DB;
    const appEnv: AppEnv = {
      config,
      db,
      now: () => new Date(),
      log,
    };

    const url = new URL(request.url);
    const method = request.method.toUpperCase() as
      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

    const cors = corsHeaders(request, config.allowedOrigins);
    const withCors = (response: Response): Response => {
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    };

    if (method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      assertRequestOrigin(request, config.allowedOrigins);

      if (!config.rateLimitDisabled) {
        const limited = enforceRateLimit(request, url.pathname, method);
        if (limited) return withCors(limited);
      }

      const matched = router.match(method, url.pathname);
      if (!matched) {
        if (router.hasPath(url.pathname)) {
          return withCors(errorResponse(405, 'method_not_allowed', 'Method not allowed'));
        }
        return withCors(errorResponse(404, 'not_found', 'Route was not found'));
      }

      if (url.pathname === '/api/auth/login' || url.pathname === '/health') {
        // Seed the singleton admin lazily on the first auth/health request.
        await ensureAdmin(db, config).catch((error) => {
          log.error?.({ event: 'admin_seed_failed' }, 'Failed to seed admin');
          console.error(error);
        });
      }

      // Opportunistic, bounded session cleanup; failures must not affect requests.
      // Workers cancel unawaited promises after the response, so register the
      // work with waitUntil rather than a bare `void` promise.
      if (url.pathname === '/api/auth/login' && !config.rateLimitDisabled) {
        context.waitUntil(pruneExpiredSessions(db, new Date()).catch(() => undefined));
      }

      const response = await matched.handler({
        request: request as unknown as Request,
        env: appEnv,
        params: matched.params,
        url,
      });
      return withCors(response);
    } catch (error) {
      return withCors(handleError(error, url.pathname));
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;

function enforceRateLimit(request: Request, pathname: string, method: string): Response | null {
  const address = clientAddress(request);
  let rule: { max: number; windowSeconds: number } | null = null;
  let key = address;
  if (pathname === '/api/auth/login' && method === 'POST') {
    rule = loginRateLimit;
    key = `login:${address}`;
  } else if (/^\/api\/notification-services\/[^/]+\/test$/.test(pathname)) {
    rule = testRateLimit;
    key = `test:${address}`;
  } else if (/^\/api\/(monitors|status-pages)\/public\//.test(pathname)) {
    rule = publicRateLimit;
    key = `public:${address}`;
  }
  if (!rule) return null;
  if (limiter.check(key, rule)) return null;
  return errorResponse(429, 'rate_limited', 'Too many requests');
}

function handleError(error: unknown, pathname: string): Response {
  if (error instanceof HttpErrorLike) {
    return errorResponse(error.status, error.code, error.message, error.fieldErrors);
  }
  // Zod errors carry `issues`.
  const zod = error as {
    issues?: { path: (string | number)[]; message: string }[];
    name?: string;
  };
  if (Array.isArray(zod.issues)) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of zod.issues) {
      const key = issue.path.join('.') || 'body';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return errorResponse(400, 'validation_error', 'Request validation failed', fieldErrors);
  }
  if (error instanceof UrlPolicyError) {
    return errorResponse(400, error.code, error.message);
  }
  // Avoid logging provider credentials embedded in SQL bind parameters.
  if (pathname.startsWith('/api/notification-services')) {
    log.error?.({ event: 'notification_request_failed' }, 'Notification request failed');
  } else {
    log.error?.({ event: 'request_failed' }, 'Unhandled API error');
    console.error(error);
  }
  return errorResponse(500, 'internal_error', 'Unexpected server error');
}

export { router as apiRouter };
