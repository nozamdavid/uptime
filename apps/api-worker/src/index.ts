import { parseRegionsList, type CloudflareEnv } from '@uptime/cloudflare';

import { createApiRouter, type AppEnv, type LogSink } from './app.js';
import { ensureAdmin, pruneExpiredSessions } from './auth.js';
import {
  IsolateRateLimiter,
  assertRequestOrigin,
  clientAddress,
  corsHeaders,
  errorResponse,
  HttpErrorLike,
  json,
  parseCookies,
} from './http.js';
import { parseApiEnv } from './env.js';
import { UrlPolicyError } from './security.js';
import { hostedFetch } from './hosted-app.js';
import { reconcileDueBilling } from './workspace-billing.js';
import { reconcileCustomStatusDomains } from './custom-domain-http.js';
import { z } from 'zod';
import {
  withPostgresRuntime,
  resolveRuntimeSource,
  type Database,
} from '@uptime/cloudflare/postgres';

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
/**
 * One scheduled reconciliation pass. Shared by the Worker cron trigger and the
 * Node runtime's interval timer; it never rejects.
 */
export async function reconcileScheduled(env: CloudflareEnv): Promise<void> {
  if (env.POSTGRES_SOURCE_DATABASE_ID !== undefined) return;
  return withPostgresRuntime(env, async (controlDb, catalog) => {
    const regions = parseRegionsList(env.REGIONS_LIST);
    // Each reconciler finishes all database work before the client closes.
    const results = [];
    for (const reconcile of [
      () => reconcileDueBilling({ control: controlDb, env, regions }, 10),
      () => reconcileCustomStatusDomains({ ...env, controlDb, catalog }, { limit: 10 }),
    ]) {
      try {
        await reconcile();
        results.push({ status: 'fulfilled' as const });
      } catch {
        results.push({ status: 'rejected' as const });
      }
    }
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected')
        log.error?.(
          {
            event: index === 0 ? 'billing_reconciliation_failed' : 'domain_reconciliation_failed',
          },
          'Scheduled reconciliation failed',
        );
    }
  }).catch(() =>
    log.error?.(
      { event: 'scheduled_configuration_failed' },
      'Scheduled runtime configuration is invalid',
    ),
  );
}

export default {
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, context: ExecutionContext) {
    context.waitUntil(reconcileScheduled(env));
  },
  async fetch(request: Request, env: CloudflareEnv, context: ExecutionContext): Promise<Response> {
    if (env.POSTGRES_SOURCE_DATABASE_ID === undefined) return hostedFetch(request, env, context);
    try {
      return await withPostgresRuntime(env, async (control, catalog) => {
        const resolved = await resolveRuntimeSource(
          control,
          catalog,
          env.POSTGRES_SOURCE_DATABASE_ID,
        );
        if (resolved.source.profile === 'full-hosted')
          throw new Error('Dedicated API requires a legacy source');
        const pending: Promise<unknown>[] = [];
        const scopedContext = {
          waitUntil(promise: Promise<unknown>) {
            pending.push(promise);
          },
          passThroughOnException() {
            context.passThroughOnException();
          },
        } as ExecutionContext;
        try {
          return await legacyFetch(request, env, scopedContext, resolved.db, resolved.workspaceId);
        } finally {
          while (pending.length) await Promise.allSettled(pending.splice(0));
        }
      });
    } catch {
      return errorResponse(500, 'internal_error', 'Worker configuration is invalid');
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;

async function legacyFetch(
  request: Request,
  env: CloudflareEnv,
  context: ExecutionContext,
  db: Database,
  workspaceId: string,
): Promise<Response> {
  let config;
  try {
    config = parseApiEnv(env);
  } catch (error) {
    console.error('Invalid API Worker configuration', error);
    return errorResponse(500, 'internal_error', 'Worker configuration is invalid');
  }

  const appEnv: AppEnv = {
    config,
    db,
    monitorCacheScope: workspaceId,
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

    const atprotoCookie = parseCookies(request.headers.get('cookie')).uptime_atproto_session;
    if (atprotoCookie && requiresOauthBridge(url.pathname)) {
      const principal = await lookupHostedIdentity(request, env);
      if (principal.importedWorkspaceId && principal.importedWorkspaceId !== workspaceId)
        throw new HttpErrorLike(403, 'forbidden', 'Workspace access denied');
      appEnv.principal = principal;
      if (url.pathname === '/api/auth/session' && method === 'GET') {
        return withCors(
          json({
            user: { did: principal.did, handle: principal.handle },
            role: principal.role ?? 'owner',
            isOperator: !principal.importedWorkspaceId,
            admin: { id: principal.did, did: principal.did, handle: principal.handle },
          }),
        );
      }
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
}

function requiresOauthBridge(pathname: string): boolean {
  if (pathname === '/api/auth/session' || pathname === '/api/auth/logout') return true;
  if (pathname.startsWith('/api/monitors/public/')) return false;
  if (pathname.startsWith('/api/status-pages/public/')) return false;
  return (
    pathname.startsWith('/api/monitors') ||
    pathname.startsWith('/api/status-pages') ||
    pathname.startsWith('/api/notification-') ||
    pathname.startsWith('/api/badges')
  );
}

interface HostedIdentity {
  id: string;
  did: string;
  handle: string;
  importedWorkspaceId?: string;
  role?: 'owner' | 'maintainer' | 'viewer';
}

async function lookupHostedIdentity(request: Request, env: CloudflareEnv): Promise<HostedIdentity> {
  const binding = env.OAUTH as { fetch(input: Request): Promise<Response> } | undefined;
  if (!binding || typeof binding.fetch !== 'function')
    throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  const workspaceId = request.headers.get('x-uptime-workspace');
  const importedWorkspace =
    env.ENVIRONMENT === 'staging' && workspaceId && z.uuid().safeParse(workspaceId).success
      ? workspaceId
      : null;
  const bridgePath = importedWorkspace ? '/api/auth/imported-identity' : '/api/auth/identity';
  let response: Response;
  try {
    // Keep the destination a fixed local route. The service binding must never
    // be redirected to a URL supplied by the caller.
    response = await binding.fetch(
      new Request(new URL(bridgePath, request.url), {
        method: 'GET',
        headers: {
          cookie: request.headers.get('cookie') ?? '',
          ...(importedWorkspace ? { 'x-uptime-workspace': importedWorkspace } : {}),
        },
      }),
    );
  } catch {
    throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  }
  if (response.status === 401)
    throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  if (response.status === 403)
    throw new HttpErrorLike(403, 'forbidden', 'Operator access required');
  if (!response.ok) throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  }
  if (!body || typeof body !== 'object') {
    throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
  }
  const candidate = body as {
    user?: { did?: unknown; handle?: unknown };
    isOperator?: unknown;
    importedWorkspaceId?: unknown;
    role?: unknown;
  };
  if (importedWorkspace) {
    if (
      candidate.importedWorkspaceId !== importedWorkspace ||
      typeof candidate.user?.did !== 'string' ||
      typeof candidate.user.handle !== 'string' ||
      candidate.user.did.length === 0 ||
      candidate.user.handle.length === 0 ||
      !['owner', 'maintainer', 'viewer'].includes(candidate.role as string)
    )
      throw new HttpErrorLike(403, 'forbidden', 'Workspace access denied');
    if (candidate.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      throw new HttpErrorLike(403, 'forbidden', 'Viewer access is read only');
    return {
      id: candidate.user.did,
      did: candidate.user.did,
      handle: candidate.user.handle,
      importedWorkspaceId: importedWorkspace,
      role: candidate.role as 'owner' | 'maintainer' | 'viewer',
    };
  }
  if (
    candidate.isOperator !== true ||
    typeof candidate.user?.did !== 'string' ||
    typeof candidate.user.handle !== 'string' ||
    candidate.user.did.length === 0 ||
    candidate.user.handle.length === 0
  )
    throw new HttpErrorLike(403, 'forbidden', 'Operator access required');
  return { id: candidate.user.did, did: candidate.user.did, handle: candidate.user.handle };
}

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
