import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { budgetEnforcementDisabled, schedulingState, setSchedulingPause } from '@uptime/cloudflare';
import {
  budgetAllowsWork,
  dispatchDueTenants,
  enforceFreePolicy,
  recordWorkspaceUsage,
  releaseStaleLeases,
  runTenantJob,
  type TenantDispatchEnv,
} from './tenant-dispatch.js';
import {
  createRuntimeFixture,
  seedMonitor,
  seedControlUser,
  seedControlWorkspace,
  first,
  all,
  count,
} from './testing-postgres.js';
import type { CoordinatorConfig } from './env.js';

let runtime: Awaited<ReturnType<typeof createRuntimeFixture>>;
const timestamp = '2026-10-04T00:00:00.000Z';
const now = new Date(timestamp);
beforeAll(async () => {
  runtime = await createRuntimeFixture(['full-hosted', 'legacy-staging', 'legacy-production']);
}, 180_000);
afterAll(async () => {
  await runtime?.close();
}, 180_000);
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (!runtime) return;
  const db = runtime.control.db;
  await db.query(`DELETE FROM ${db.table('dispatch_outbox')}`);
  await db.query(`DELETE FROM ${db.table('scheduling_controls')}`);
  await db.query(`DELETE FROM ${db.table('workspace_usage_daily')}`);
  await db.query(
    `UPDATE ${db.table('postgres_tenant_registry')} SET workspace_id=NULL,status='available'`,
  );
  await db.query(`UPDATE ${db.table('tenant_slots')} SET workspace_id=NULL,status='available'`);
  await db.query(`DELETE FROM ${db.table('workspaces')}`);
  await db.query(
    `UPDATE ${db.table('service_controls')} SET admission_open=1,external_monthly_cost_usd=0,monthly_budget_usd=20 WHERE id=1`,
  );
  for (let index = 0; index < runtime.tenants.length; index++) {
    const tenant = runtime.tenants[index]!.db;
    await tenant.query(`DELETE FROM ${tenant.table('monitors')}`);
    await tenant.query(`DELETE FROM ${tenant.table('jobs')}`);
    await tenant.query(
      `DELETE FROM ${tenant.table(runtime.catalog.sources[index]!.identityTable!)}`,
    );
  }
}, 180_000);

function config(): CoordinatorConfig {
  return {
    db: runtime.tenants[0]!.db,
    reports: null,
    reportIntervalSeconds: 60,
    staleAfterSeconds: 180,
    enabledRegionIds: ['us-east', 'eu-west', 'asia', 'asia-east'],
    enabledRegions: [],
    workersUrlDomain: 'account.workers.dev',
    probeSigningSecret: 'x'.repeat(40),
    credentialEncryptionSecret: 'y'.repeat(40),
    monitorBatch: 50,
    probeConcurrency: 32,
    probeRequestMaxSkewSeconds: 60,
    notificationMaxAttempts: 8,
    detailedResultsRetentionDays: 7,
    dnsDiagnosticsRetentionDays: 7,
    environment: 'test',
  };
}

async function env(at = now): Promise<TenantDispatchEnv> {
  return {
    ...runtime.env,
    controlDb: await runtime.openConnection(),
    catalog: runtime.catalog,
    ENVIRONMENT: 'production',
    REGIONS_LIST: 'us-east,asia',
    WORKERS_URL_DOMAIN: 'account.workers.dev',
    PROBE_SIGNING_SECRET: 'x'.repeat(40),
    CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
    CURRENT_BUDGET_USAGE_JSON: JSON.stringify({
      month: at.toISOString().slice(0, 7),
      observedAt: at.toISOString(),
      cloudflareCostUsd: 5,
    }),
  } as unknown as TenantDispatchEnv;
}

async function outbox(workspaceId: string, at = timestamp) {
  const db = runtime.control.db;
  await db.query(
    `INSERT INTO ${db.table('dispatch_outbox')} (id,workspace_id,scheduled_at,status,attempts,next_attempt_at,created_at)
    VALUES ($1,$2,$3,'sent',1,$3,$3) ON CONFLICT (workspace_id,scheduled_at) DO NOTHING`,
    [`${workspaceId}:${at}`, workspaceId, at],
  );
}

describe('hosted tenant policy and metering', () => {
  it('clears stale execution leases at startup', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000010';
    await runtime.assign(0, workspaceId, 'did:plc:stale-lease');
    const db = runtime.control.db;
    await db.query(
      `UPDATE ${db.table('workspaces')} SET execution_lease_token = $1, execution_lease_until = $2 WHERE id = $3`,
      [crypto.randomUUID(), '2099-01-01T00:00:00.000Z', workspaceId],
    );
    expect(await releaseStaleLeases(db)).toBe(1);
    expect(
      await first(
        db,
        `SELECT execution_lease_token, execution_lease_until FROM ${db.table('workspaces')} WHERE id = $1`,
        [workspaceId],
      ),
    ).toEqual({ execution_lease_token: null, execution_lease_until: null });
    expect(await releaseStaleLeases(db)).toBe(0);
  });

  it('does not run a scheduled tick when the saved policy names a removed region', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const workspaceId = '00000000-0000-4000-8000-000000000009';
    await runtime.assign(0, workspaceId, 'did:plc:removed-region');
    const db = runtime.control.db,
      tenant = runtime.tenants[0]!.db;
    await db.query(
      `INSERT INTO ${db.table('workspace_product_limits')} (workspace_id,monitors,regions,allowed_region_ids,updated_at)
      VALUES ($1,3,1,'["eu-west"]',$2)`,
      [workspaceId, timestamp],
    );
    await seedMonitor(tenant, {
      regions: ['eu-west'],
      intervalSeconds: 300,
      timeoutMs: 10_000,
      outageThreshold: 2,
      recoveryThreshold: 1,
      nextCheckAt: timestamp,
    });
    await outbox(workspaceId);
    const fetchMock = vi.fn().mockResolvedValue(new Response('unexpected probe'));
    vi.stubGlobal('fetch', fetchMock);
    const session = await env();
    await expect(
      runTenantJob(session, { workspaceId, scheduledAt: timestamp }, now),
    ).rejects.toThrow(/region that is not configured/);
    await db.query(
      `UPDATE ${db.table('workspace_product_limits')} SET allowed_region_ids='["us-east"]' WHERE workspace_id=$1`,
      [workspaceId],
    );
    await expect(
      runTenantJob(session, { workspaceId, scheduledAt: timestamp }, now),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(tenant, `SELECT region_id FROM ${tenant.table('monitor_regions')}`)).toEqual([
      { region_id: 'eu-west' },
    ]);
    await db.query(
      `INSERT INTO ${db.table('scheduling_controls')} (scope,paused,reason,actor,changed_at) VALUES ($1,1,'maintenance','operator',$2)`,
      [workspaceId, timestamp],
    );
    // Distinct dispatches keep the completion fence from masking pause decisions.
    const run = async (offset: number, maintenanceOnly?: boolean) => {
      const scheduledAt = new Date(now.getTime() + offset).toISOString();
      await outbox(workspaceId, scheduledAt);
      await runTenantJob(
        session,
        { workspaceId, scheduledAt, ...(maintenanceOnly === undefined ? {} : { maintenanceOnly }) },
        new Date(scheduledAt),
      );
    };
    await run(1_000);
    expect(
      await first(tenant, `SELECT name FROM ${tenant.table('jobs')} WHERE name='retention'`),
    ).toEqual({ name: 'retention' });
    await db.query(`UPDATE ${db.table('scheduling_controls')} SET paused=0 WHERE scope=$1`, [
      workspaceId,
    ]);
    await db.query(`UPDATE ${db.table('service_controls')} SET external_monthly_cost_usd=16`);
    await run(2_000);
    expect(
      await first(db, `SELECT paused FROM ${db.table('scheduling_controls')} WHERE scope='budget'`),
    ).toEqual({ paused: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    await db.query(`UPDATE ${db.table('service_controls')} SET external_monthly_cost_usd=0`);
    await run(3_000, true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count(tenant, 'check_runs')).toBe(0);
    expect(await first(tenant, `SELECT enabled FROM ${tenant.table('monitors')}`)).toEqual({
      enabled: 1,
    });
  });

  it('bounds free tenants to three regions and fixed retention windows', () => {
    const result = enforceFreePolicy(config());
    expect(result.enabledRegionIds).toEqual(['eu-west', 'us-east', 'asia']);
    expect(result.detailedResultsRetentionDays).toBe(1);
    expect(result.dnsDiagnosticsRetentionDays).toBe(30);
  });

  it('dispatches every region granted by a workspace policy above the defaults', () => {
    const limits = {
      monitors: 8,
      regions: 5,
      allowedRegionIds: ['eu-west', 'us-east', 'asia', 'asia-east', 'asia-south'] as const,
    };
    const result = enforceFreePolicy(
      { ...config(), enabledRegionIds: [...config().enabledRegionIds, 'asia-south'] },
      { ...limits, allowedRegionIds: [...limits.allowedRegionIds] },
    );
    expect(result.enabledRegionIds).toEqual(limits.allowedRegionIds);
    expect(result.enabledRegionIds).toHaveLength(5);
  });

  it('aggregates query work per workspace and day', async () => {
    const db = runtime.control.db,
      workspaceId = '00000000-0000-4000-8000-000000000010';
    await seedControlUser(db, 'did:plc:metering', 'owner.test');
    await seedControlWorkspace(db, { workspaceId, ownerDid: 'did:plc:metering' });
    const at = new Date('2026-10-02T12:00:00.000Z');
    await recordWorkspaceUsage(
      db,
      workspaceId,
      at,
      { probes: { rowsRead: 4, rowsWritten: 2 }, reports: { rowsRead: 3, rowsWritten: 1 } },
      3,
      900,
    );
    await recordWorkspaceUsage(
      db,
      workspaceId,
      at,
      { probes: { rowsRead: 1, rowsWritten: 5 } },
      2,
      700,
    );
    const rows = await all<{
      workspace_id: string;
      day: string;
      checks: number;
      rows_read: string;
      rows_written: string;
      storage_bytes: string;
    }>(db, `SELECT * FROM ${db.table('workspace_usage_daily')}`);
    expect(
      rows.map((row) => ({
        ...row,
        rows_read: Number(row.rows_read),
        rows_written: Number(row.rows_written),
        storage_bytes: Number(row.storage_bytes),
      })),
    ).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        day: '2026-10-02',
        checks: 5,
        rows_read: 8,
        rows_written: 8,
        storage_bytes: 900,
      }),
    ]);
  });

  it('stops hosted work at the configured forecast ceiling while preserving the gate state', async () => {
    const db = runtime.control.db;
    await db.query(
      `UPDATE ${db.table('service_controls')} SET external_monthly_cost_usd=16 WHERE id=1`,
    );
    expect(
      await budgetAllowsWork(db, now, {
        month: '2026-10',
        observedAt: timestamp,
        cloudflareCostUsd: 5,
      }),
    ).toBe(false);
    expect(
      (await first<{ admission_open: number }>(
        db,
        `SELECT admission_open FROM ${db.table('service_controls')} WHERE id=1`,
      ))!.admission_open,
    ).toBe(0);
  });

  it('ignores unknown and over-ceiling cost only when enforcement is explicitly disabled', async () => {
    const db = runtime.control.db;
    const workspaceId = '00000000-0000-4000-8000-000000000011';
    await seedControlUser(db, 'did:plc:budget-off', 'owner.test');
    await seedControlWorkspace(db, { workspaceId, ownerDid: 'did:plc:budget-off' });
    await db.query(
      `UPDATE ${db.table('service_controls')} SET external_monthly_cost_usd=50 WHERE id=1`,
    );
    // Default and any value other than "true" keep enforcing, and persist the pause.
    expect(await budgetAllowsWork(db, now, undefined, budgetEnforcementDisabled({}))).toBe(false);
    expect(
      budgetEnforcementDisabled({ BUDGET_ENFORCEMENT_DISABLED: 'false' }) ||
        budgetEnforcementDisabled({ BUDGET_ENFORCEMENT_DISABLED: '1' }),
    ).toBe(false);
    expect(
      await first(db, `SELECT paused FROM ${db.table('scheduling_controls')} WHERE scope='budget'`),
    ).toEqual({ paused: 1 });
    await db.query(`UPDATE ${db.table('service_controls')} SET admission_open=0 WHERE id=1`);

    const disabled = budgetEnforcementDisabled({ BUDGET_ENFORCEMENT_DISABLED: 'true' });
    expect(disabled).toBe(true);
    expect(await budgetAllowsWork(db, now, undefined, disabled)).toBe(true);
    // The stored automatic pause stays on record but has no effect, and admission is not opened.
    expect((await schedulingState(db)).paused).toBe(true);
    expect((await schedulingState(db, workspaceId, { ignoreBudget: disabled })).paused).toBe(false);
    expect(
      (await first<{ admission_open: number }>(
        db,
        `SELECT admission_open FROM ${db.table('service_controls')} WHERE id=1`,
      ))!.admission_open,
    ).toBe(0);
    // Manual workspace and fleet pauses still apply.
    await setSchedulingPause(db, workspaceId, true, 'maintenance', 'operator', now);
    expect((await schedulingState(db, workspaceId, { ignoreBudget: disabled })).paused).toBe(true);
    await setSchedulingPause(db, workspaceId, false, 'done', 'operator', now);
    await setSchedulingPause(db, 'fleet', true, 'maintenance', 'operator', now);
    expect((await schedulingState(db, workspaceId, { ignoreBudget: disabled })).paused).toBe(true);
  });

  it('does not enqueue or purge the imported staging workspace', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    await runtime.assign(1, workspaceId, 'did:plc:legacy-staging');
    const db = runtime.control.db;
    await db.query(`UPDATE ${db.table('workspaces')} SET next_dispatch_at=$1 WHERE id=$2`, [
      timestamp,
      workspaceId,
    ]);
    const sent: unknown[] = [];
    const result = await dispatchDueTenants(
      {
        ...(await env()),
        ENVIRONMENT: 'staging',
        TENANT_JOBS: { send: async (job: unknown) => void sent.push(job) },
      } as unknown as TenantDispatchEnv,
      now,
    );
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('drops stale imported jobs before taking a lease', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000002';
    await runtime.assign(1, workspaceId, 'did:plc:stale-staging');
    await runTenantJob(
      { ...(await env()), ENVIRONMENT: 'staging' },
      { workspaceId, scheduledAt: timestamp },
      now,
    );
    const db = runtime.control.db;
    expect(
      await first(db, `SELECT execution_lease_token FROM ${db.table('workspaces')} WHERE id=$1`, [
        workspaceId,
      ]),
    ).toEqual({ execution_lease_token: null });
  });

  it('dispatches ordinary databases in production', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const workspaceId = '00000000-0000-4000-8000-000000000003';
    await runtime.assign(0, workspaceId, 'did:plc:ordinary');
    const db = runtime.control.db;
    await db.query(`UPDATE ${db.table('workspaces')} SET next_dispatch_at=$1 WHERE id=$2`, [
      timestamp,
      workspaceId,
    ]);
    const sent: unknown[] = [],
      session = await env();
    expect(
      (
        await dispatchDueTenants(
          {
            ...session,
            TENANT_JOBS: { send: async (job: unknown) => void sent.push(job) },
          } as unknown as TenantDispatchEnv,
          now,
        )
      ).sent,
    ).toBe(1);
    expect(sent).toHaveLength(1);
    await db.query(`UPDATE ${db.table('workspaces')} SET next_dispatch_at=NULL`);
    await db.query(
      `INSERT INTO ${db.table('scheduling_controls')} (scope,paused,reason,actor,changed_at) VALUES ('fleet',1,'maintenance','operator',$1)`,
      [timestamp],
    );
    // This control-only dispatch does not open the remaining tenant pool schemas.
    const sources = Array.from({ length: 22 }, (_, n) => ({
      sourceDatabaseId: `dispatch-source-${n + 4}`,
      schema: `${runtime.control.schema}_s${n + 4}`,
      profile: 'full-hosted' as const,
    }));
    const records = sources.map((source, n) => ({
      id: `00000000-0000-4000-8001-${String(n + 4).padStart(12, '0')}`,
      source: source.sourceDatabaseId,
      schema: source.schema,
    }));
    await db.query(
      `INSERT INTO ${db.table('users')} (did,handle,state,created_at,updated_at,last_seen_at)
      SELECT 'did:plc:' || id,'dispatch.test','active',$2,$2,$2
      FROM jsonb_to_recordset($1::jsonb) x(id text,source text,schema text)`,
      [JSON.stringify(records), timestamp],
    );
    await db.query(
      `INSERT INTO ${db.table('workspaces')} (id,owner_did,name,state,plan,created_at,updated_at)
      SELECT id,'did:plc:' || id,'Dispatch','active','free',$2,$2 FROM jsonb_to_recordset($1::jsonb) x(id text,source text,schema text)`,
      [JSON.stringify(records), timestamp],
    );
    await db.query(
      `INSERT INTO ${db.table('postgres_tenant_registry')} (source_database_id,workspace_id,schema_name,status)
      SELECT source,id,schema,'assigned' FROM jsonb_to_recordset($1::jsonb) x(id text,source text,schema text)`,
      [JSON.stringify(records)],
    );
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined);
    const pausedResult = await dispatchDueTenants(
      {
        ...session,
        catalog: {
          ...runtime.catalog,
          sources: [
            ...runtime.catalog.sources,
            ...sources.map((source) => ({ ...runtime.catalog.sources[0]!, ...source })),
          ],
        },
        TENANT_JOBS: { send },
      } as unknown as TenantDispatchEnv,
      new Date(now.getTime() + 60_000),
    );
    expect(pausedResult).toEqual({ attempted: 20, sent: 19, failed: 1 });
    expect(send).toHaveBeenCalledTimes(20);
    expect(send.mock.calls.every(([job]) => job.maintenanceOnly === true)).toBe(true);
    expect(
      (await first<{ count: number }>(
        db,
        `SELECT count(*)::int AS count FROM ${db.table('dispatch_outbox')} WHERE status='pending'`,
      ))!.count,
    ).toBe(1);
  });

  it('skips missed windows after downtime instead of walking them one per minute', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000005';
    await runtime.assign(0, workspaceId, 'did:plc:downtime');
    const db = runtime.control.db;
    // Older than the 7 day job window: walking it would make every dispatch a silent no-op.
    await db.query(`UPDATE ${db.table('workspaces')} SET next_dispatch_at=$1 WHERE id=$2`, [
      new Date(now.getTime() - 8 * 86_400_000).toISOString(),
      workspaceId,
    ]);
    const sent: { scheduledAt: string }[] = [];
    await dispatchDueTenants(
      {
        ...(await env()),
        TENANT_JOBS: { send: async (job: { scheduledAt: string }) => void sent.push(job) },
      } as unknown as TenantDispatchEnv,
      now,
    );
    expect(sent.map((job) => job.scheduledAt)).toEqual([timestamp]);
    expect(
      await first(db, `SELECT next_dispatch_at FROM ${db.table('workspaces')} WHERE id=$1`, [
        workspaceId,
      ]),
    ).toEqual({ next_dispatch_at: new Date(now.getTime() + 60_000).toISOString() });
  });

  it('does not dispatch, execute, or purge the production legacy workspace', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000004';
    await runtime.assign(2, workspaceId, 'did:plc:legacy-production');
    const db = runtime.control.db;
    await db.query(`UPDATE ${db.table('workspaces')} SET next_dispatch_at=$1 WHERE id=$2`, [
      timestamp,
      workspaceId,
    ]);
    const sent: unknown[] = [],
      session = {
        ...(await env()),
        TENANT_JOBS: { send: async (job: unknown) => void sent.push(job) },
      } as unknown as TenantDispatchEnv;
    expect(await dispatchDueTenants(session, now)).toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    await runTenantJob(session, { workspaceId, scheduledAt: timestamp }, now);
    expect(
      await first(db, `SELECT execution_lease_token FROM ${db.table('workspaces')} WHERE id=$1`, [
        workspaceId,
      ]),
    ).toEqual({ execution_lease_token: null });
    await db.query(`UPDATE ${db.table('workspaces')} SET state='deleting' WHERE id=$1`, [
      workspaceId,
    ]);
    await dispatchDueTenants(session, new Date(now.getTime() + 60_000));
    expect(
      await first(db, `SELECT state FROM ${db.table('workspaces')} WHERE id=$1`, [workspaceId]),
    ).toEqual({ state: 'deleting' });
  });
});
