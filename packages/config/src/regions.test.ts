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

  it('uses intervals that divide one UTC day exactly', () => {
    expect(checkIntervalPresets.every((interval) => 86_400 % interval === 0)).toBe(true);
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

  it('requires one probe endpoint for every canonical region', () => {
    const endpoints = Object.fromEntries(
      regions.map(({ endpointEnvName, id }) => [
        endpointEnvName,
        `https://${id}.probe.example.com`,
      ]),
    );
    const source = {
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      ...endpoints,
    };
    expect(schedulerEnvSchema.parse(source)).toMatchObject(endpoints);
    const missingOne: Record<string, unknown> = { ...source };
    delete missingOne.PROBE_EU_NORTH_URL;
    expect(() => schedulerEnvSchema.parse(missingOne)).toThrow();
  });
});
