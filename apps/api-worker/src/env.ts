import { parseRegionsList, sessionTtlSeconds, type CloudflareEnv } from '@uptime/cloudflare';
import { regionById, type RegionDefinition, type RegionId } from '@uptime/regions';
import { z } from 'zod';

import { isSupportedPasswordHash } from './password-hash.js';

/**
 * Validated Worker configuration for the API deployment.
 *
 * Workers bindings arrive as strings, so the schema coerces numeric and
 * boolean values before the application uses them.
 */
const envBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

const envSchema = z.object({
  ADMIN_EMAIL: z.email(),
  // Workers cannot execute Argon2; only the PBKDF2 PHC form is verifiable there.
  ADMIN_PASSWORD_HASH: z
    .string()
    .refine(
      isSupportedPasswordHash,
      'must be a supported pbkdf2-sha256 PHC string with at most 100000 iterations',
    ),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.string().optional(),
  SESSION_COOKIE_SECURE: envBoolean.optional(),
  SESSION_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).optional(),
  REGIONS_LIST: z.string().optional(),
  WEB_ORIGIN: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  ENVIRONMENT: z.string().optional(),
  // AES-GCM key material for provider credentials stored in D1.
  CREDENTIAL_ENCRYPTION_SECRET: z.string().min(32),
  DISABLE_RATE_LIMIT: envBoolean.optional(),
});

export interface ApiConfig {
  adminEmail: string;
  adminPasswordHash: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  sessionCookieSecure: boolean;
  sessionCookieSameSite: 'strict' | 'lax' | 'none';
  enabledRegionIds: RegionId[];
  enabledRegions: RegionDefinition[];
  allowedOrigins: readonly string[];
  credentialEncryptionSecret: string;
  rateLimitDisabled: boolean;
  environment: string | undefined;
}

function parseOrigins(source: {
  WEB_ORIGIN?: string | undefined;
  ALLOWED_ORIGINS?: string | undefined;
}) {
  const values = [source.WEB_ORIGIN, source.ALLOWED_ORIGINS]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return [...new Set(values)];
}

export function parseApiEnv(source: CloudflareEnv): ApiConfig {
  const env = source.CONTROL_DB
    ? envSchema.omit({ ADMIN_EMAIL: true, ADMIN_PASSWORD_HASH: true }).parse(source)
    : envSchema.parse(source);
  const enabledRegionIds = parseRegionsList(env.REGIONS_LIST);
  const environment = env.ENVIRONMENT;
  const sessionCookieSecure = env.SESSION_COOKIE_SECURE ?? environment === 'production';
  // When Pages and this Worker use different origins, credentialed fetch
  // requires `SameSite=None; Secure`;
  // browsers reject `None` without `Secure`, so fall back to `Strict` on HTTP.
  const sessionCookieSameSite =
    env.SESSION_COOKIE_SAMESITE ?? (sessionCookieSecure ? 'none' : 'strict');
  if (sessionCookieSameSite === 'none' && !sessionCookieSecure) {
    throw new Error('SESSION_COOKIE_SAMESITE=none requires SESSION_COOKIE_SECURE=true');
  }
  return {
    adminEmail: 'ADMIN_EMAIL' in env && typeof env.ADMIN_EMAIL === 'string' ? env.ADMIN_EMAIL : '',
    adminPasswordHash:
      'ADMIN_PASSWORD_HASH' in env && typeof env.ADMIN_PASSWORD_HASH === 'string'
        ? env.ADMIN_PASSWORD_HASH
        : '',
    sessionSecret: env.SESSION_SECRET,
    sessionTtlSeconds: sessionTtlSeconds(
      env.SESSION_TTL_SECONDS === undefined ? {} : { SESSION_TTL_SECONDS: env.SESSION_TTL_SECONDS },
    ),
    sessionCookieSecure,
    sessionCookieSameSite,
    enabledRegionIds,
    enabledRegions: enabledRegionIds.map((regionId) => regionById[regionId]),
    allowedOrigins: parseOrigins(env),
    credentialEncryptionSecret: env.CREDENTIAL_ENCRYPTION_SECRET,
    rateLimitDisabled: env.DISABLE_RATE_LIMIT ?? false,
    environment,
  };
}
