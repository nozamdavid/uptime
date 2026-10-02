/**
 * HTTP plumbing: JSON responses, cookie handling, CORS and rate limiting.
 *
 * No Node HTTP APIs are used so every helper runs unchanged in the Workers
 * runtime and in the SQLite-backed test harness.
 */

export const SESSION_COOKIE = 'uptime_session';

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function noContent(init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return new Response(null, { ...init, status: 204, headers });
}

export function apiError(
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } } {
  return { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): Response {
  return json(apiError(code, message, fieldErrors), { status });
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly'];
  parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join('; ');
}

export function clearCookie(name: string, options: CookieOptions): string {
  return serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    // A malformed percent-encoding must not throw an unhandled 500 out of an
    // auth check; keep the raw value so the session simply fails to match.
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpErrorLike(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

/** Lightweight error carrying an HTTP status + stable code. */
export class HttpErrorLike extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'HttpErrorLike';
  }
}

export function corsHeaders(
  request: Request,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || allowedOrigins.length === 0) return {};
  if (!allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/**
 * Enforce an allowlist on state-changing requests. Same-origin requests without
 * an `Origin` header (server-to-server, curl) are permitted; a present origin
 * must match the configured allowlist exactly.
 */
export function assertRequestOrigin(request: Request, allowedOrigins: readonly string[]): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (allowedOrigins.length === 0) {
    // No allowlist configured: derive same-origin from the request URL.
    if (origin === new URL(request.url).origin) return;
    throw new HttpErrorLike(403, 'origin_forbidden', 'Request origin is not allowed');
  }
  if (!allowedOrigins.includes(origin)) {
    throw new HttpErrorLike(403, 'origin_forbidden', 'Request origin is not allowed');
  }
}

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Best-effort fixed-window rate limiting.
 *
 * LIMITATION: Worker isolates are ephemeral and distributed, so this only
 * constrains a single isolate. Use Cloudflare Rate Limiting rules (or Durable
 * Objects) for production-grade enforcement.
 */
export class IsolateRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  check(key: string, rule: RateLimitRule, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1_000 });
      return true;
    }
    if (bucket.count >= rule.max) return false;
    bucket.count += 1;
    return true;
  }
}

export function clientAddress(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
