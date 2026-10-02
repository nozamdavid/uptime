import { describe, expect, it } from 'vitest';

import { hashPassword } from '@uptime/cloudflare';

import { parseApiEnv } from './env.js';

const passwordHash = await hashPassword('correct horse battery staple');

function source(overrides: Record<string, unknown> = {}) {
  return {
    DB: {},
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: 'a'.repeat(32),
    CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
    ...overrides,
  } as never;
}

describe('api worker environment', () => {
  it('defaults to all regions and secure SameSite=None cookies in production', () => {
    const config = parseApiEnv(source({ ENVIRONMENT: 'production' }));
    expect(config.enabledRegionIds).toHaveLength(9);
    expect(config.sessionCookieSecure).toBe(true);
    expect(config.sessionCookieSameSite).toBe('none');
  });

  it('uses strict cookies outside production', () => {
    const config = parseApiEnv(source({ ENVIRONMENT: 'development' }));
    expect(config.sessionCookieSecure).toBe(false);
    expect(config.sessionCookieSameSite).toBe('strict');
  });

  it('rejects SameSite=None without Secure', () => {
    expect(() =>
      parseApiEnv(source({ SESSION_COOKIE_SAMESITE: 'none', SESSION_COOKIE_SECURE: 'false' })),
    ).toThrow('requires SESSION_COOKIE_SECURE');
  });

  it('parses the region subset and origins', () => {
    const config = parseApiEnv(
      source({
        REGIONS_LIST: 'us-east,eu-west',
        WEB_ORIGIN: 'https://app.example.com',
        ALLOWED_ORIGINS: 'https://other.example.com,https://app.example.com',
      }),
    );
    expect(config.enabledRegionIds).toEqual(['us-east', 'eu-west']);
    expect(config.allowedOrigins).toEqual(['https://app.example.com', 'https://other.example.com']);
  });

  it('rejects an Argon2 hash since Workers cannot verify it', () => {
    expect(() =>
      parseApiEnv(source({ ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def' })),
    ).toThrow('pbkdf2-sha256');
  });

  it.each([
    ['an iteration count above the Worker limit', passwordHash.replace('$100000$', '$100001$')],
    ['an invalid salt length', replaceHashPart(passwordHash, 2, 'YQ')],
    ['an invalid key length', replaceHashPart(passwordHash, 3, 'YQ')],
  ])('rejects %s', (_label, unsupportedHash) => {
    expect(() => parseApiEnv(source({ ADMIN_PASSWORD_HASH: unsupportedHash }))).toThrow(
      'supported pbkdf2-sha256',
    );
  });

  it('requires an encryption secret of at least 32 characters', () => {
    expect(() => parseApiEnv(source({ CREDENTIAL_ENCRYPTION_SECRET: 'short' }))).toThrow();
  });

  it('clamped session ttl respects the shared bounds', () => {
    expect(() => parseApiEnv(source({ SESSION_TTL_SECONDS: '1' }))).toThrow('SESSION_TTL_SECONDS');
    expect(parseApiEnv(source({ SESSION_TTL_SECONDS: '3600' })).sessionTtlSeconds).toBe(3600);
  });
});

function replaceHashPart(hash: string, index: number, replacement: string): string {
  const parts = hash.split('$');
  parts[index] = replacement;
  return parts.join('$');
}
