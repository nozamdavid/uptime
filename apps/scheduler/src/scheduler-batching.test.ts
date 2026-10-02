import { regions, schedulerEnvSchema } from '@uptime/config';
import type { Database } from '@uptime/database';
import { describe, expect, it, vi } from 'vitest';

import { Scheduler } from './scheduler.js';

vi.mock('./url-policy.js', () => ({
  assertCurrentlyPublicTarget: vi.fn().mockResolvedValue(undefined),
}));

describe('regional probe batching', () => {
  it.each([
    { monitorCount: 2, expectedBatchSizes: [2] },
    { monitorCount: 6, expectedBatchSizes: [5, 1] },
  ])(
    'sends $monitorCount due same-region monitors in bounded batches',
    async ({ monitorCount, expectedBatchSizes }) => {
      const runIds = Array.from(
        { length: monitorCount },
        (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      );
      const monitorIds = Array.from(
        { length: monitorCount },
        (_, index) => `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      );
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(
          runIds.map((id, index) => ({
            id,
            monitor_id: monitorIds[index],
            monitor_url: `https://example.com/${index}`,
            timeout_ms: 1_000,
            window_started_at: new Date('2026-08-30T12:00:00.000Z'),
            region_ids: ['eu-west'],
            dns_diagnostics_enabled: false,
          })),
        )
        .mockResolvedValue([]);
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          requestId: string;
          regionId: string;
          items: { checkRunId: string; monitorId: string }[];
        };
        return new Response(
          JSON.stringify({
            requestId: request.requestId,
            regionId: request.regionId,
            results: request.items.map((item) => ({
              ...item,
              response: {
                regionId: request.regionId,
                status: 'success',
                success: true,
                httpStatus: 200,
                responseMs: 10,
                totalMs: 12,
                errorCode: null,
                errorDetail: null,
                placement: null,
                colo: 'LHR',
                finalUrl: 'https://example.com/',
                redirectCount: 0,
                bodyBytes: 2,
                probeVersion: 'test',
                startedAt: '2026-08-30T12:00:01.000Z',
                completedAt: '2026-08-30T12:00:01.012Z',
              },
            })),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const env = schedulerEnvSchema.parse({
        DATABASE_URL: 'postgresql://uptime:test@localhost:5432/uptime',
        PROBE_SIGNING_SECRET: 'a'.repeat(32),
        SCHEDULER_INSTANCE_ID: 'test',
        WORKERS_URL_DOMAIN: 'example.workers.dev',
      });
      const warn = vi.fn();
      const scheduler = new Scheduler(env, {
        db: { execute } as unknown as Database,
        fetch: fetchMock as typeof fetch,
        now: () => new Date('2026-08-30T12:00:01.000Z'),
        log: { info: vi.fn(), warn, error: vi.fn() },
      });

      await scheduler.tick();

      expect(fetchMock).toHaveBeenCalledTimes(expectedBatchSizes.length);
      const batchSizes = fetchMock.mock.calls.map((call) => {
        const sent = JSON.parse(String(call[1]?.body)) as { items: unknown[] };
        return sent.items.length;
      });
      expect(batchSizes).toEqual(expectedBatchSizes);
      expect(warn).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(6 + monitorCount * 2);
    },
  );
});
