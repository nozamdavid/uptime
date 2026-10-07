import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCoordinatorEnv, parseReportEnv, type CoordinatorConfig } from './env.js';
import { claimJob, readJob } from './state.js';
import {
  first,
  count,
  useTenantDatabase,
  createRuntimeFixture,
  seedMonitor,
  seedObservation,
  seedRound,
} from './testing-postgres.js';
import { seedControlUser, seedControlWorkspace } from './testing-postgres.js';
import type { ReporterRuntimeEnv } from './reporter.js';

import { FakeR2 } from './testing-r2.js';
import { regionIds } from '@uptime/regions';

import {
  coordinatorLeaseSeconds,
  coordinatorRuntimeDependencies,
  reportLeaseSeconds,
  runReportSchedule,
  runtimeFetch,
} from './index.js';
import { runReportJob } from './report-job.js';
import reporter from './reporter.js';
import { reportCohortPointerKey, reportCohortIndexKey } from './publisher.js';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

const makeDatabase = useTenantDatabase();
let runtime: Awaited<ReturnType<typeof createRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createRuntimeFixture(['legacy-production']);
}, 180_000);
afterAll(async () => {
  await runtime?.close();
}, 180_000);

function runtimeEnv(): ReporterRuntimeEnv {
  return {
    ...runtime.env,
    POSTGRES_SOURCE_DATABASE_ID: 'source-1',
    WORKERS_URL_DOMAIN: 'account.workers.dev',
    PROBE_SIGNING_SECRET: 'x'.repeat(40),
    CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
    REPORTS: new FakeR2(),
    CURRENT_BUDGET_USAGE_JSON: JSON.stringify({
      month: '2026-09',
      observedAt: '2026-09-20T10:00:00.000Z',
      cloudflareCostUsd: 0,
    }),
  } as unknown as ReporterRuntimeEnv;
}

function config(db: CoordinatorConfig['db']): CoordinatorConfig {
  return {
    db,
    reports: null,
    enabledRegionIds: ['us-east'],
    enabledRegions: [],
    workersUrlDomain: 'account.workers.dev',
    probeSigningSecret: 'x'.repeat(40),
    credentialEncryptionSecret: 'y'.repeat(40),
    reportIntervalSeconds: 60,
    staleAfterSeconds: 180,
    monitorBatch: 50,
    probeConcurrency: 32,
    probeRequestMaxSkewSeconds: 60,
    notificationMaxAttempts: 8,
    detailedResultsRetentionDays: 7,
    dnsDiagnosticsRetentionDays: 30,
    environment: 'test',
  };
}

describe('coordinator runtime dependencies', () => {
  it('runs the identity-verified legacy coordinator in maintenance mode under a CONTROL pause', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000107';
    await runtime.assign(0, workspaceId, 'did:plc:legacy-coordinator');
    const db = runtime.tenants[0]!.db;
    const control = runtime.control.db;
    await control.query(
      `INSERT INTO ${control.table('scheduling_controls')}
      (scope,paused,reason,actor,changed_at) VALUES ('fleet',1,'maintenance','operator',$1)`,
      ['2026-09-20T10:00:00.000Z'],
    );
    await seedMonitor(db, { regions: ['us-east'], nextCheckAt: '2026-09-20T10:00:00.000Z' });
    const env = { ...runtimeEnv(), ENVIRONMENT: 'production', LEGACY_IMPORT_COORDINATOR: 'true' };
    await (await import('./index.js')).default.scheduled({} as never, env);
    expect(await count(db, 'check_runs')).toBe(0);
    expect(await first(db, `SELECT name FROM ${db.table('jobs')} WHERE name='retention'`)).toEqual({
      name: 'retention',
    });
    expect(
      await first(
        control,
        `SELECT workspace_id FROM ${control.table('coordinator_runtime_health')}`,
      ),
    ).toEqual({ workspace_id: workspaceId });
    await db.query(`UPDATE ${db.table('production_workspace_identity')} SET database_id='wrong'`);
    try {
      await expect(
        (await import('./index.js')).default.scheduled({} as never, env),
      ).rejects.toThrow(/identity mismatch/i);
    } finally {
      await db.query(
        `UPDATE ${db.table('production_workspace_identity')} SET database_id='source-1'`,
      );
      await db.query(`DELETE FROM ${db.table('monitors')}`);
      await db.query(`DELETE FROM ${db.table('jobs')}`);
      await control.query(`DELETE FROM ${control.table('scheduling_controls')}`);
    }
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('acknowledges queued work for a suspended workspace without resolving a tenant database', async () => {
    const db = runtime.control.db;
    await seedControlUser(db, 'did:plc:00000000-0000-4000-8000-000000000001', 'owner.test');
    await seedControlWorkspace(db, {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      ownerDid: 'did:plc:00000000-0000-4000-8000-000000000001',
      state: 'suspended',
    });

    let acknowledged = false;
    let retried = false;
    await (
      await import('./index.js')
    ).default.queue(
      {
        messages: [
          {
            body: {
              workspaceId: '00000000-0000-4000-8000-000000000001',
              scheduledAt: '2026-09-20T10:00:00.000Z',
            },
            ack: () => (acknowledged = true),
            retry: () => (retried = true),
          },
        ],
      } as never,
      runtimeEnv(),
    );
    expect(acknowledged).toBe(true);
    expect(retried).toBe(false);
  });

  it('retries queued work when an active workspace has a live execution lease', async () => {
    const db = runtime.control.db;
    await seedControlUser(db, 'did:plc:00000000-0000-4000-8000-000000000002', 'owner.test');
    await seedControlWorkspace(db, {
      workspaceId: '00000000-0000-4000-8000-000000000002',
      ownerDid: 'did:plc:00000000-0000-4000-8000-000000000002',
      state: 'active',
    });
    await db.query(
      `UPDATE ${db.table('workspaces')} SET execution_lease_token='held', execution_lease_until='2099-01-01T00:00:00.000Z' WHERE id=$1`,
      ['00000000-0000-4000-8000-000000000002'],
    );
    await db.query(
      `INSERT INTO ${db.table('dispatch_outbox')} (id,workspace_id,scheduled_at,status,attempts,next_attempt_at,created_at)
      VALUES ($1,$1,$2,'sent',1,$2,$2)`,
      ['00000000-0000-4000-8000-000000000002', '2026-09-20T10:00:00.000Z'],
    );
    let acknowledged = false;
    let retried = false;
    await (
      await import('./index.js')
    ).default.queue(
      {
        messages: [
          {
            body: {
              workspaceId: '00000000-0000-4000-8000-000000000002',
              scheduledAt: '2026-09-20T10:00:00.000Z',
            },
            ack: () => (acknowledged = true),
            retry: () => (retried = true),
          },
        ],
      } as never,
      runtimeEnv(),
    );
    expect(acknowledged).toBe(false);
    expect(retried).toBe(true);
  });
  it('runs the separate reporter with native PostgreSQL and R2 bindings', async () => {
    const db = runtime.tenants[0]!.db;
    const env = runtimeEnv();
    expect(parseReportEnv({ ...env, DB: db }, db).reports).toBe(env.REPORTS);
    await reporter.scheduled({} as ScheduledController, env);
    expect((await readJob(db, 'reports'))?.last_completed_at).not.toBeNull();
    expect(env.REPORTS instanceof FakeR2 && env.REPORTS.store.has(reportCohortPointerKey)).toBe(
      true,
    );
  });

  it('runs the separate reporter against the legacy production schema without hosted metadata', async () => {
    const db = runtime.tenants[0]!.db;
    const env = runtimeEnv();
    await reporter.scheduled({} as ScheduledController, env);
    expect(env.REPORTS instanceof FakeR2 && env.REPORTS.store.has(reportCohortPointerKey)).toBe(
      true,
    );
    expect(await first(db, `SELECT name FROM ${db.table('jobs')} WHERE name='reports'`)).toEqual({
      name: 'reports',
    });
    expect(() => db.table('workspace_metadata')).toThrow();
    expect(
      (
        await db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name='workspace_metadata'",
          [db.schema],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='production_workspace_identity' ORDER BY ordinal_position",
          [db.schema],
        )
      ).rows.map((row) => row.column_name),
    ).toEqual(['id', 'workspace_id', 'database_id']);
  });

  it('keeps coordinator report scheduling enabled unless explicitly disabled', () => {
    const { db } = makeDatabase();
    const env = {
      DB: db,
      WORKERS_URL_DOMAIN: 'account.workers.dev',
      PROBE_SIGNING_SECRET: 'x'.repeat(40),
      CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
    };
    expect(parseCoordinatorEnv(env, db).reportScheduleDisabled).toBe(false);
    expect(
      parseCoordinatorEnv({ ...env, REPORT_SCHEDULE_DISABLED: 'true' }, db).reportScheduleDisabled,
    ).toBe(true);
  });

  it('leaves the clock live for batches queued after tick startup', () => {
    expect(coordinatorRuntimeDependencies().now).toBeUndefined();
  });

  it('holds the job lease across a worst-case queued probe minute', async () => {
    const { db } = makeDatabase();
    const now = new Date('2026-09-20T10:00:00.000Z');
    const seconds = coordinatorLeaseSeconds({
      enabledRegionIds: [...regionIds],
      probeConcurrency: 32,
    });
    expect(seconds).toBe(195);
    expect(await claimJob(db, 'coordinator', now, seconds)).not.toBeNull();
    expect(await claimJob(db, 'coordinator', new Date(now.getTime() + 60_000), seconds)).toBeNull();
  });

  it('publishes under a separate lease while the coordinator lease is held', async () => {
    const { db } = makeDatabase();
    const now = new Date('2026-09-20T10:00:00.000Z');
    await seedMonitor(db, {
      isPublic: 1,
      publicSlug: 'independent-report',
      nextCheckAt: '2026-09-20T11:00:00.000Z',
    });
    const reportsBucket = new FakeR2();
    expect(await claimJob(db, 'coordinator', now, 195)).not.toBeNull();

    await runReportSchedule({ ...config(db), reports: reportsBucket }, now);

    const reports = await readJob(db, 'reports');
    expect(reports?.last_completed_at).not.toBeNull();
    expect(reports?.lease_token).toBeNull();
    const metrics = JSON.parse(reports?.state_json ?? '{}') as {
      durationMs?: number;
      published?: number;
      queryWork?: Record<string, { statements: number }>;
    };
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.published).toBeGreaterThan(0);
    expect(metrics.queryWork?.['reports']?.statements).toBeGreaterThanOrEqual(0);
    const pointer = JSON.parse(reportsBucket.store.get(reportCohortPointerKey)!.body);
    const snapshot = reportsBucket.store.get(reportCohortIndexKey(pointer.generation));
    expect(snapshot).toBeDefined();
    expect(snapshot?.customMetadata['generatedAt']).toBeDefined();
    expect(await claimJob(db, 'coordinator', new Date(now.getTime() + 60_000), 195)).toBeNull();
  });

  it('uses a report lease long enough to prevent an overlapping slow publisher', async () => {
    const { db } = makeDatabase();
    const now = new Date('2026-09-20T10:00:00.000Z');
    expect(await claimJob(db, 'reports', now, reportLeaseSeconds)).not.toBeNull();
    expect(
      await claimJob(db, 'reports', new Date(now.getTime() + 60_000), reportLeaseSeconds),
    ).toBeNull();
  });

  it('maintains disabled publication without claiming or overwriting the separate reporter job', async () => {
    // Use the live clock for this disabled-publication retention fixture.
    vi.useRealTimers();
    const { db } = makeDatabase();
    const monitorId = await seedMonitor(db, { isPublic: 1 });
    const now = new Date();
    await seedRound(db, {
      id: 'disabled-round',
      monitorId,
      windowStartedAt: now.toISOString(),
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
      checkRunId: 'disabled-round',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: now.toISOString(),
      startedAt: now.toISOString(),
      success: true,
    });
    expect(await count(db, 'report_latency_changes')).toBe(0);
    await db.query(
      `INSERT INTO ${db.table('jobs')} (name,state_json) VALUES ('reports','{"reporterMetrics":true}')`,
    );
    const reports = new FakeR2();
    await runReportSchedule({ ...config(db), reports }, now, true);
    expect(await count(db, 'report_latency_changes')).toBe(0);
    expect(reports.store.size).toBe(0);
    expect((await readJob(db, 'reports'))?.lease_token).toBeNull();
    expect((await readJob(db, 'reports'))?.state_json).toBe('{"reporterMetrics":true}');
  });

  it('records the live publication minute and wall duration independently', async () => {
    const { db } = makeDatabase();
    const times = [
      new Date('2026-09-20T10:01:03.000Z'),
      new Date('2026-09-20T10:01:03.120Z'),
      new Date('2026-09-20T10:01:03.240Z'),
    ];
    const metrics = await runReportJob(config(db), {
      log: { warn: () => undefined, error: () => undefined },
      now: () => times.shift()!,
    });

    expect(metrics.lastTickAt).toBe('2026-09-20T10:01:03.000Z');
    expect(metrics.updatedAt).toBe('2026-09-20T10:01:03.240Z');
    expect(metrics.durationMs).toBe(240);
  });

  it.each([
    { concurrency: 8, expectedSeconds: 632 },
    { concurrency: 3, expectedSeconds: 1360 },
  ])(
    'bounds uneven adaptive region queues at concurrency $concurrency',
    ({ concurrency, expectedSeconds }) => {
      expect(
        coordinatorLeaseSeconds({
          enabledRegionIds: [...regionIds],
          probeConcurrency: concurrency,
        }),
      ).toBe(expectedSeconds);
    },
  );

  it('calls native fetch with globalThis as its receiver', async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('ok'));
    } as typeof fetch;
    globalThis.fetch = receiverSensitiveFetch;

    try {
      const detachedFetch = globalThis.fetch;
      expect(() => detachedFetch('https://example.test')).toThrow('Illegal invocation');

      const response = await runtimeFetch('https://example.test');
      expect(await response.text()).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
