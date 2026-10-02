import { schedulerEnvSchema } from '@uptime/config';
import type { Database } from '@uptime/database';
import { describe, expect, it, vi } from 'vitest';

import { Scheduler } from './scheduler.js';

vi.mock('./url-policy.js', () => ({
  assertCurrentlyPublicTarget: vi.fn().mockResolvedValue(undefined),
}));

describe('scheduler diagnostic reservations', () => {
  it('accepts the timestamp representation returned by raw PostgreSQL queries', async () => {
    const windowStartedAt = new Date('2026-08-30T12:00:00.000Z');
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000001',
          monitor_id: '00000000-0000-4000-8000-000000000002',
          monitor_url: 'https://example.com',
          timeout_ms: 1_000,
          window_started_at: windowStartedAt,
          region_ids: ['eu-west'],
          dns_diagnostics_enabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000003',
          regionId: 'eu-west',
          windowStartedAt: windowStartedAt.toISOString(),
        },
      ])
      .mockResolvedValue([]);
    const env = schedulerEnvSchema.parse({
      DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
      PROBE_SIGNING_SECRET: 'a'.repeat(32),
      SCHEDULER_INSTANCE_ID: 'test',
      WORKERS_URL_DOMAIN: 'example.workers.dev',
    });
    const scheduler = new Scheduler(env, {
      db: { execute } as unknown as Database,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
      now: () => new Date('2026-08-30T12:00:01.000Z'),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
