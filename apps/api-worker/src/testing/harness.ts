import { createApiRouter, type AppDependencies } from '../app.js';
import type { ApiConfig } from '../env.js';
import { UrlPolicyError } from '../security.js';

import type { CloudflareEnv } from '@uptime/cloudflare';
import type { D1Database } from '@uptime/cloudflare';

/**
 * Test harness that drives the Worker's router directly with the shared
 * `node:sqlite` D1 adapter, so tests exercise the real migration and queries.
 */

export interface TestHarnessOptions extends AppDependencies {
  db: D1Database;
  config?: Partial<ApiConfig>;
}

export interface TestApp {
  fetch(request: Request): Promise<Response>;
  config: ApiConfig;
}

export const defaultTestConfig: ApiConfig = {
  adminEmail: 'admin@example.com',
  adminPasswordHash: '',
  sessionSecret: 'a'.repeat(32),
  sessionTtlSeconds: 604_800,
  sessionCookieSecure: false,
  sessionCookieSameSite: 'strict',
  enabledRegionIds: [
    'us-east',
    'us-west',
    'canada-central',
    'eu-west',
    'eu-north',
    'eu-south',
    'asia',
    'asia-east',
    'asia-south',
  ],
  enabledRegions: [],
  allowedOrigins: [],
  credentialEncryptionSecret: 'c'.repeat(32),
  rateLimitDisabled: true,
  environment: 'test',
};

export function buildTestApp(options: TestHarnessOptions): TestApp {
  const merged = { ...defaultTestConfig, ...options.config };
  const config: ApiConfig = {
    ...merged,
    enabledRegions: merged.enabledRegionIds.map((id) => ({
      id,
      label: id,
      continentId: 'north-america',
      placementRegion: 'aws:us-east-1',
      approximateAnchor: id,
      workerName: `uptime-probe-${id}`,
      wranglerConfigBasename: `wrangler.${id}.toml`,
      chartSeriesToken: '--region-series-1',
    })) as ApiConfig['enabledRegions'],
  };
  const router = createApiRouter(options);
  const env = {
    config,
    db: options.db,
    now: options.now ?? (() => new Date()),
    log: options.log ?? { warn: () => undefined },
  };
  return {
    config,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method.toUpperCase() as
        'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
      const matched = router.match(method, url.pathname);
      if (!matched) {
        if (router.hasPath(url.pathname)) {
          return errorJson(405, 'method_not_allowed', 'Method not allowed');
        }
        return errorJson(404, 'not_found', 'Route was not found');
      }
      try {
        return await matched.handler({ request, env, params: matched.params, url });
      } catch (error) {
        return errorToResponse(error);
      }
    },
  };
}

function errorJson(
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function errorToResponse(error: unknown): Response {
  const candidate = error as {
    status?: number;
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string[]>;
    issues?: { path: (string | number)[]; message: string }[];
  };
  if (typeof candidate.status === 'number' && candidate.code) {
    return errorJson(
      candidate.status,
      candidate.code,
      candidate.message ?? 'Error',
      candidate.fieldErrors,
    );
  }
  if (Array.isArray(candidate.issues)) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of candidate.issues) {
      const key = issue.path.join('.') || 'body';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return errorJson(400, 'validation_error', 'Request validation failed', fieldErrors);
  }
  if (error instanceof UrlPolicyError) {
    return errorJson(400, error.code, error.message);
  }
  console.error(error);
  return errorJson(500, 'internal_error', 'Unexpected server error');
}

export type { CloudflareEnv };
