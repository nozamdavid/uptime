import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import type { CloudflareEnv } from '@uptime/cloudflare';
import { parsePostgresRuntimeCatalog } from '@uptime/cloudflare/postgres';

import { parseApiEnv } from './env.js';
import { createHttpBinding } from './node-bindings.js';
import { createR2S3Bucket } from './r2-s3.js';

/** Settings consumed by the Node adapter itself. They never reach the handler env. */
export interface NodeRuntimeConfig {
  host: string;
  port: number;
  /** Base for every request URL. The Host header is never trusted. */
  publicOrigin: URL;
  maxBodyBytes: number;
  /** Socket peers allowed to supply the client address via forwarding headers. */
  trustedProxies: ReadonlySet<string>;
  gatewayToken: string | null;
  reconcileIntervalMs: number;
  shutdownGraceMs: number;
}

export interface NodeRuntime {
  config: NodeRuntimeConfig;
  env: CloudflareEnv;
}

const adapterKeys = [
  'API_HOST',
  'API_PORT',
  'API_MAX_BODY_BYTES',
  'API_TRUSTED_PROXIES',
  'API_GATEWAY_TOKEN',
  'API_RECONCILE_INTERVAL_SECONDS',
  'API_SHUTDOWN_GRACE_SECONDS',
  'POSTGRES_URL',
  'POSTGRES_RUNTIME_CATALOG_FILE',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_REPORTS_BUCKET',
  'R2_ENDPOINT',
  'IMPORTED_API_URL',
  'IMPORTED_REPORTER_URL',
] as const;

function integer(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

/** Strings only: unset or empty values must look absent to the handler. */
function passthrough(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === 'string' &&
      value !== '' &&
      !(adapterKeys as readonly string[]).includes(key)
    )
      result[key] = value;
  }
  return result;
}

/**
 * Translate process environment variables into the Worker env contract.
 *
 * Fails closed: any missing or malformed required setting throws an error that
 * names the variable and never includes its value.
 */
export function loadNodeRuntime(source: NodeJS.ProcessEnv): NodeRuntime {
  if (source.POSTGRES_SOURCE_DATABASE_ID !== undefined && source.POSTGRES_SOURCE_DATABASE_ID !== '')
    throw new Error(
      'POSTGRES_SOURCE_DATABASE_ID selects the dedicated legacy API and is unsupported',
    );

  const environment = source.ENVIRONMENT;
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(required(source, 'PUBLIC_ORIGIN'));
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an absolute URL');
  }
  if (
    publicOrigin.origin === 'null' ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search !== '' ||
    publicOrigin.username !== ''
  )
    throw new Error('PUBLIC_ORIGIN must be a bare origin');
  if (publicOrigin.protocol !== 'https:' && environment !== 'development')
    throw new Error('PUBLIC_ORIGIN must use https outside development');

  const connectionString = required(source, 'POSTGRES_URL');
  if (!/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new Error('POSTGRES_URL must be a postgres:// connection string');

  let catalog = source.POSTGRES_RUNTIME_CATALOG;
  const catalogFile = source.POSTGRES_RUNTIME_CATALOG_FILE;
  if (catalog === undefined || catalog === '') {
    if (!catalogFile)
      throw new Error('POSTGRES_RUNTIME_CATALOG or POSTGRES_RUNTIME_CATALOG_FILE is required');
    try {
      catalog = readFileSync(catalogFile, 'utf8');
    } catch {
      throw new Error('POSTGRES_RUNTIME_CATALOG_FILE could not be read');
    }
  }
  parsePostgresRuntimeCatalog(catalog);

  const trustedProxies = new Set(
    (source.API_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const entry of trustedProxies)
    if (isIP(entry) === 0) throw new Error('API_TRUSTED_PROXIES must list IP addresses');

  const gatewayToken = source.API_GATEWAY_TOKEN ? source.API_GATEWAY_TOKEN : null;
  if (gatewayToken !== null && gatewayToken.length < 32)
    throw new Error('API_GATEWAY_TOKEN must be at least 32 characters');

  const env: CloudflareEnv = {
    ...passthrough(source),
    DB: undefined as never,
    POSTGRES: { connectionString },
    POSTGRES_RUNTIME_CATALOG: catalog,
  };
  delete env.POSTGRES_SOURCE_DATABASE_ID;
  // Fail on missing secrets now rather than on the first request.
  parseApiEnv(env);
  required(env as Record<string, string>, 'OAUTH_STORAGE_SECRET');

  const r2Keys = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_REPORTS_BUCKET'] as const;
  const r2Present = r2Keys.filter((key) => source[key]);
  if (r2Present.length > 0 && r2Present.length < r2Keys.length)
    throw new Error(
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_REPORTS_BUCKET must be set together',
    );
  if (r2Present.length === r2Keys.length) {
    const endpoint =
      source.R2_ENDPOINT ||
      `https://${required(source, 'CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
    env.REPORTS = createR2S3Bucket({
      endpoint,
      bucket: source.R2_REPORTS_BUCKET!,
      accessKeyId: source.R2_ACCESS_KEY_ID!,
      secretAccessKey: source.R2_SECRET_ACCESS_KEY!,
    });
  }
  if (source.IMPORTED_API_URL) env.IMPORTED_API = createHttpBinding(source.IMPORTED_API_URL);
  if (source.IMPORTED_REPORTER_URL)
    env.IMPORTED_REPORTER = createHttpBinding(source.IMPORTED_REPORTER_URL);

  return {
    env,
    config: {
      host: source.API_HOST || '127.0.0.1',
      port: integer(source, 'API_PORT', 8787, 1, 65_535),
      publicOrigin,
      maxBodyBytes: integer(source, 'API_MAX_BODY_BYTES', 1_048_576, 1_024, 16_777_216),
      trustedProxies,
      gatewayToken,
      reconcileIntervalMs: integer(source, 'API_RECONCILE_INTERVAL_SECONDS', 60, 10, 3_600) * 1_000,
      shutdownGraceMs: integer(source, 'API_SHUTDOWN_GRACE_SECONDS', 25, 1, 120) * 1_000,
    },
  };
}
