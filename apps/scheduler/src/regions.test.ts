import { describe, expect, it } from 'vitest';

import { regions, schedulerEnvSchema } from '@uptime/config';

import { probeEndpointFor } from './scheduler.js';

describe('canonical probe endpoint lookup', () => {
  it('resolves all nine canonical regions from their Worker names and one domain', () => {
    const env = schedulerEnvSchema.parse({
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      WORKERS_URL_DOMAIN: 'example.workers.dev',
    });

    expect(regions.map((region) => probeEndpointFor(env, region.id))).toEqual(
      regions.map((region) => `https://${region.workerName}.example.workers.dev`),
    );
  });
});
