import { readFileSync } from 'node:fs';

import { createR2S3Bucket } from '@uptime/api-worker/r2-s3';
import { parsePostgresRuntimeCatalog, type Database } from '@uptime/cloudflare/postgres';

import { parseCoordinatorEnv, type CoordinatorEnv } from './env.js';

export interface SchedulerConfig {
  /** False validates configuration and then stays idle. */
  enabled: boolean;
  shutdownGraceMs: number;
}

export interface SchedulerRuntime {
  config: SchedulerConfig;
  env: CoordinatorEnv;
}

/** Consumed here; never forwarded to the coordinator env. */
const adapterKeys = [
  'SCHEDULER_ENABLED',
  'SCHEDULER_SHUTDOWN_GRACE_SECONDS',
  'POSTGRES_URL',
  'POSTGRES_RUNTIME_CATALOG_FILE',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_REPORTS_BUCKET',
  'R2_ENDPOINT',
];

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function boolean(source: NodeJS.ProcessEnv, name: string): boolean {
  const value = required(source, name);
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

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

/**
 * Startup error text that is safe to log: it must name a variable and read like
 * a rule. Library messages that may echo a configured value are replaced.
 */
export function safeConfigMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(?:Missing required binding: [A-Z0-9_]+|[A-Z][A-Z0-9_]+ (?:\(or [A-Z0-9_]+\) )?(?:is required|must)[\w ,.:/-]*)$/.test(
    message,
  )
    ? message
    : 'A configuration setting is invalid';
}

/**
 * Translate process environment variables into the coordinator env contract.
 *
 * Fails closed: a missing or malformed setting throws an error that names the
 * variable and never includes its value.
 */
export function loadSchedulerRuntime(source: NodeJS.ProcessEnv): SchedulerRuntime {
  const enabled = boolean(source, 'SCHEDULER_ENABLED');

  const connectionString = required(source, 'POSTGRES_URL');
  if (!/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new Error('POSTGRES_URL must be a postgres:// connection string');

  let catalog: string;
  try {
    catalog = readFileSync(required(source, 'POSTGRES_RUNTIME_CATALOG_FILE'), 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('is required')) throw error;
    throw new Error('POSTGRES_RUNTIME_CATALOG_FILE could not be read');
  }
  parsePostgresRuntimeCatalog(catalog);

  const env: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source))
    if (typeof value === 'string' && value !== '' && !adapterKeys.includes(key)) env[key] = value;
  env.POSTGRES = { connectionString };
  env.POSTGRES_RUNTIME_CATALOG = catalog;

  // Reports are published every minute, so partial R2 settings are never accepted.
  const endpoint =
    source.R2_ENDPOINT ||
    `https://${required(source, 'CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
  const bucket = required(source, 'R2_REPORTS_BUCKET');
  const accessKeyId = required(source, 'R2_ACCESS_KEY_ID');
  const secretAccessKey = required(source, 'R2_SECRET_ACCESS_KEY');
  try {
    env.REPORTS = createR2S3Bucket({ endpoint, bucket, accessKeyId, secretAccessKey });
  } catch {
    throw new Error('R2_REPORTS_BUCKET must be a valid bucket name and R2_ENDPOINT an https URL');
  }

  // Fail on missing coordinator settings now rather than at the first job.
  parseCoordinatorEnv(env as unknown as CoordinatorEnv, {} as Database);

  return {
    env: env as unknown as CoordinatorEnv,
    config: {
      enabled,
      shutdownGraceMs: integer(source, 'SCHEDULER_SHUTDOWN_GRACE_SECONDS', 25, 1, 120) * 1_000,
    },
  };
}
