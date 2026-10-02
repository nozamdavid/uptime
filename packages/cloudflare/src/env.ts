import { regionIds, type RegionId } from './regions.js';
import type { D1Database, R2Bucket } from './workers-types.js';

/**
 * Common Worker bindings for every Cloudflare deployment in this repository.
 *
 * Secrets are optional on the type because each Worker only receives the subset
 * it needs; callers that require a binding should use `requireBinding`.
 */
export interface CloudflareEnv {
  DB: D1Database;
  REPORTS?: R2Bucket;
  SESSION_SECRET?: string;
  PROBE_SIGNING_SECRET?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_TTL_SECONDS?: string;
  REGIONS_LIST?: string;
  WORKERS_URL_DOMAIN?: string;
  ENVIRONMENT?: string;
  [binding: string]: unknown;
}

const defaultSessionTtlSeconds = 604_800;

/** Parse `REGIONS_LIST` with the same semantics as the Node configuration. */
export function parseRegionsList(value: string | undefined): RegionId[] {
  if (value === undefined || value.trim() === '') return [...regionIds];
  const parsed = value.split(',').map((entry) => entry.trim());
  if (parsed.some((entry) => entry === '')) {
    throw new Error('REGIONS_LIST must be a comma-separated list without empty entries');
  }
  const invalid = parsed.filter((entry) => !(regionIds as readonly string[]).includes(entry));
  if (invalid.length > 0) {
    throw new Error(`REGIONS_LIST contains unknown regions: ${[...new Set(invalid)].join(', ')}`);
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('REGIONS_LIST must not contain duplicate regions');
  }
  return parsed as RegionId[];
}

export function sessionTtlSeconds(env: Pick<CloudflareEnv, 'SESSION_TTL_SECONDS'>): number {
  const raw = env.SESSION_TTL_SECONDS;
  if (raw === undefined || raw === '') return defaultSessionTtlSeconds;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 300 || value > 31_536_000) {
    throw new Error('SESSION_TTL_SECONDS must be an integer between 300 and 31536000');
  }
  return value;
}

/** Assert a required binding/secret is present, returning it with a narrow type. */
export function requireBinding<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Missing required binding: ${name}`);
  }
  return value;
}

/** `true` for `1`/`true`/`yes` values coming from D1 or Worker vars. */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
  }
  return false;
}
