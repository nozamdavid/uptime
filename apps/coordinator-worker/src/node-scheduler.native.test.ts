import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSchedulerTick } from './node-scheduler.js';
import { createRuntimeFixture, first } from './testing-postgres.js';

const workspaceId = '00000000-0000-4000-8000-0000000000a1';
const minute = new Date('2026-10-05T12:01:00.000Z');

// Needs a disposable PostgreSQL server (POSTGRES_TEST_ADMIN_URL), like the other native tests.
describe.skipIf(!process.env.POSTGRES_TEST_ADMIN_URL)('scheduler tick against PostgreSQL', () => {
  let runtime: Awaited<ReturnType<typeof createRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createRuntimeFixture(['full-hosted']);
    await runtime.assign(0, workspaceId, 'did:plc:scheduler-test');
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await runtime?.close();
  }, 180_000);

  it('runs a maintenance-only dispatch when budget evidence is absent, then retries a busy lease', async () => {
    // runTenantJob checks its scheduled window against the real clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(minute);
    const fetchMock = vi.fn().mockResolvedValue(new Response('unexpected probe'));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.fn();
    const tick = createSchedulerTick(
      {
        ...runtime.env,
        ENVIRONMENT: 'staging',
        REGIONS_LIST: 'us-east,asia',
        WORKERS_URL_DOMAIN: 'account.workers.dev',
        PROBE_SIGNING_SECRET: 'x'.repeat(40),
        CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
      } as never,
      log,
    );
    const control = runtime.control.db;
    const tenant = runtime.tenants[0]!.db;
    const outbox = () =>
      first(
        control,
        `SELECT status, attempts, last_error FROM ${control.table('dispatch_outbox')} WHERE workspace_id = $1`,
        [workspaceId],
      );

    // Hold the execution lease: the job fails, so the outbox row stays pending.
    await control.query(
      `UPDATE ${control.table('workspaces')} SET execution_lease_token = 'held', execution_lease_until = $2 WHERE id = $1`,
      [workspaceId, '2099-01-01T00:00:00.000Z'],
    );
    await tick(minute, new AbortController().signal);
    expect(await outbox()).toEqual({
      status: 'pending',
      attempts: 2,
      last_error: 'Queue send failed',
    });
    expect(log).toHaveBeenCalledWith(
      'scheduler_dispatch',
      expect.objectContaining({ attempted: 1, sent: 0, failed: 1 }),
    );

    // Release it and let the retry window pass: the same dispatch now completes.
    await control.query(
      `UPDATE ${control.table('workspaces')} SET execution_lease_token = NULL, execution_lease_until = NULL WHERE id = $1`,
      [workspaceId],
    );
    await control.query(`UPDATE ${control.table('dispatch_outbox')} SET next_attempt_at = $1`, [
      minute.toISOString(),
    ]);
    await tick(minute, new AbortController().signal);
    expect(await outbox()).toEqual({ status: 'sent', attempts: 3, last_error: null });
    expect(
      await first(tenant, `SELECT name FROM ${tenant.table('jobs')} WHERE name LIKE 'dispatch:%'`),
    ).toEqual({ name: `dispatch:${minute.toISOString()}` });
    expect(
      await first(tenant, `SELECT count(*)::int AS count FROM ${tenant.table('check_runs')}`),
    ).toEqual({ count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 120_000);
});
