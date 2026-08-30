import { describe, expect, it } from 'vitest';

import { regions, schedulerEnvSchema } from '@uptime/config';

import { probeEndpointFor } from './scheduler.js';

describe('canonical probe endpoint lookup', () => {
  it('resolves all nine canonical regions through their configured endpoint names', () => {
    const endpoints = Object.fromEntries(
      regions.map((region) => [region.endpointEnvName, `https://${region.id}.example.test`]),
    );
    const env = schedulerEnvSchema.parse({
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      ...endpoints,
    });

    expect(regions.map((region) => probeEndpointFor(env, region.id))).toEqual(
      regions.map((region) => `https://${region.id}.example.test`),
    );
  });
});
