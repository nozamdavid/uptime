import { describe, expect, it } from 'vitest';

import { checkIntervalPresets, regionById, regions } from './regions.js';
import { regions as canonicalRegions } from '@uptime/regions';

import { apiEnvSchema, databaseEnvSchema, schedulerEnvSchema } from './env.js';

describe('regional configuration', () => {
  it('defines each logical region exactly once', () => {
    expect(regions).toBe(canonicalRegions);
    expect(regions.map(({ id }) => id)).toHaveLength(9);
    expect(regionById.asia.placementRegion).toBe('aws:ap-southeast-1');
  });

  it('uses one-minute intervals through 15 minutes, then five-minute intervals through 60', () => {
    expect(checkIntervalPresets.slice(0, 15)).toEqual(
      Array.from({ length: 15 }, (_, index) => (index + 1) * 60),
    );
    expect(checkIntervalPresets.slice(15)).toEqual(
      Array.from({ length: 9 }, (_, index) => (index + 4) * 300),
    );
  });
});

describe('environment configuration', () => {
  it('accepts PostgreSQL connection URLs and rejects unrelated protocols', () => {
    expect(
      databaseEnvSchema.parse({ DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime' }),
    ).toEqual({ DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime' });
    expect(() => databaseEnvSchema.parse({ DATABASE_URL: 'https://example.com' })).toThrow();
  });

  it('defaults proxy trust to zero hops and accepts only non-negative integers', () => {
    const source = {
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      SESSION_COOKIE_SECURE: false,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
      SESSION_SECRET: 'a'.repeat(32),
    };

    expect(apiEnvSchema.parse(source).API_TRUST_PROXY_HOPS).toBe(0);
    expect(apiEnvSchema.parse({ ...source, API_TRUST_PROXY_HOPS: '2' }).API_TRUST_PROXY_HOPS).toBe(
      2,
    );
    expect(() => apiEnvSchema.parse({ ...source, API_TRUST_PROXY_HOPS: -1 })).toThrow();
    expect(() => apiEnvSchema.parse({ ...source, API_TRUST_PROXY_HOPS: 1.5 })).toThrow();
  });

  it('builds every probe endpoint from one normalized Workers domain', () => {
    const source = {
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      WORKERS_URL_DOMAIN: 'ACCOUNT.WORKERS.DEV',
    };
    expect(schedulerEnvSchema.parse(source).WORKERS_URL_DOMAIN).toBe('account.workers.dev');
    expect(() =>
      schedulerEnvSchema.parse({
        ...source,
        WORKERS_URL_DOMAIN: 'https://account.workers.dev/path',
      }),
    ).toThrow(/bare domain/);
  });

  it('parses REGIONS_LIST independently of the shared Workers domain', () => {
    const source = {
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      REGIONS_LIST: 'asia-east, asia-south',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      WORKERS_URL_DOMAIN: 'account.workers.dev',
    };
    expect(schedulerEnvSchema.parse(source).REGIONS_LIST).toEqual(['asia-east', 'asia-south']);
    expect(() => schedulerEnvSchema.parse({ ...source, REGIONS_LIST: 'asia-east,moon' })).toThrow(
      /unknown regions: moon/,
    );
  });
});
