import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createControlFixture,
  createTenantFixture,
  grantTenantAccessToControl,
  seedControlUserAndWorkspace,
  seedTenantIdentity,
  type ControlTestFixture,
  type TenantTestFixture,
} from './testing/postgres-fixtures.js';
import {
  readProductCatalog,
  saveProductCatalog,
  applyWorkspaceTier,
  resolveEffectiveEntitlements,
  syncTierEntitlements,
  tierSchedulingState,
  defaultProductCatalog,
  schedulerPolicyTables,
} from './product-tiers.js';
import {
  saveWorkspaceProductLimits,
  savedWorkspaceProductLimits,
} from './product-limits.js';
import {
  schedulingState,
  setSchedulingPause,
  recordBudgetPause,
} from './operations.js';
import {
  meterDatabase,
  flushUsage,
} from './usage-meter.js';
import {
  recordNotificationHistory,
} from './notification-history.js';
import {
  resolveWorkspaceDatabase,
} from './tenancy.js';
import {
  purgeWorkspaceData,
} from './tenant-lifecycle.js';
import {
  isImportedWorkspace,
} from './staging-import.js';
import { pgFirst, pgRun } from './postgres/query.js';

const TEST_URL = process.env.POSTGRES_TEST_ADMIN_URL;
const describePg = TEST_URL ? describe : describe.skip;

describePg('Native PostgreSQL Control & Tenant Business Logic', () => {
  let control: ControlTestFixture;
  let tenant: TenantTestFixture;
  const configured = [
    'eu-west',
    'us-east',
    'asia',
    'us-west',
    'canada-central',
    'eu-north',
    'eu-south',
    'asia-east',
    'asia-south',
  ] as const;

  beforeAll(async () => {
    control = await createControlFixture();
    tenant = await createTenantFixture('tenant-db-01', 'full-hosted');
    await grantTenantAccessToControl(control, tenant);
    await seedTenantIdentity(tenant.db, {
      workspaceId: 'ws-tenant-sync-01',
      sourceDatabaseId: 'tenant-db-01',
    });
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([control?.close(), tenant?.close()]);
  }, 60_000);

  it('serializes concurrent first-catalog creation at revision 0 across two connections', async () => {
    const conn1 = await control.fixture.openConnection();
    const conn2 = await control.fixture.openConnection();

    const initial = defaultProductCatalog(configured);
    const cat1 = {
      ...initial,
      revision: 1,
      plans: initial.plans.map((p) => ({ ...p, revision: 1 })),
    };
    const cat2 = {
      ...initial,
      revision: 1,
      plans: initial.plans.map((p) => ({ ...p, revision: 1, name: 'Conflict Plan' })),
    };

    const results = await Promise.allSettled([
      saveProductCatalog(conn1, configured, cat1, 0, 'did:plc:admin-1', 'First 1'),
      saveProductCatalog(conn2, configured, cat2, 0, 'did:plc:admin-2', 'First 2'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason.message).toMatch(/Catalog changed; reload before saving/);

    const current = await readProductCatalog(control.db, configured);
    expect(current.revision).toBe(1);
  }, 30_000);

  it('manages versioned product catalogs in native PostgreSQL', async () => {
    const current = await readProductCatalog(control.db, configured);
    expect(current.revision).toBe(1);
    expect(current.plans.length).toBeGreaterThan(0);

    const saved = await saveProductCatalog(
      control.db,
      configured,
      {
        ...current,
        revision: 2,
        plans: current.plans.map((plan) => ({ ...plan, revision: 2 })),
      },
      1,
      'did:plc:admin-test',
      'Second catalog publish',
    );
    expect(saved.revision).toBe(2);

    const updated = await readProductCatalog(control.db, configured);
    expect(updated.revision).toBe(2);

    // Rejects conflicting save
    await expect(
      saveProductCatalog(
        control.db,
        configured,
        {
          ...current,
          revision: 2,
          plans: current.plans.map((plan) => ({ ...plan, revision: 2 })),
        },
        1,
        'did:plc:admin-test',
        'Conflict',
      ),
    ).rejects.toThrow(/Catalog changed; reload before saving/);
  }, 30_000);

  it('applies workspace tiers and audits transitions on native PostgreSQL', async () => {
    const workspaceId = 'ws-test-tier-apply-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const effective = await applyWorkspaceTier(control.db, {
      workspaceId,
      tierId: 'free',
      revision: 2,
      expectedGeneration: 0,
      actor: 'did:plc:admin',
      reason: 'Initial assignment',
      configuredRegionIds: configured,
    });

    expect(effective.tierId).toBe('free');
    expect(effective.generation).toBe(1);
    expect(effective.entitlements.monitors).toBeGreaterThan(0);

    const resolved = await resolveEffectiveEntitlements(control.db, workspaceId, configured);
    expect(resolved.tierId).toBe('free');
    expect(resolved.generation).toBe(1);

    const events = await control.db.query<{ event: string; actor_did: string }>(
      `SELECT event, actor_did FROM ${control.db.table('workspace_events')}
       WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0]!.event).toBe('tier_assigned');
    expect(events.rows[0]!.actor_did).toBe('did:plc:admin');
  }, 30_000);

  it('serializes competing tier assignments and produces zero audit events on the loser', async () => {
    const workspaceId = 'ws-test-tier-cas-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const conn1 = await control.fixture.openConnection();
    const conn2 = await control.fixture.openConnection();

    const results = await Promise.allSettled([
      applyWorkspaceTier(conn1, {
        workspaceId,
        tierId: 'free',
        revision: 2,
        expectedGeneration: 0,
        actor: 'did:plc:admin-1',
        reason: 'Assignment 1',
        configuredRegionIds: configured,
      }),
      applyWorkspaceTier(conn2, {
        workspaceId,
        tierId: 'free',
        revision: 2,
        expectedGeneration: 0,
        actor: 'did:plc:admin-2',
        reason: 'Assignment 2',
        configuredRegionIds: configured,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason.message).toMatch(/Workspace policy changed or execution is busy/);

    // Exactly 1 tier_assigned audit event exists (loser wrote zero events)
    const events = await control.db.query<{ id: string }>(
      `SELECT id FROM ${control.db.table('workspace_events')}
       WHERE workspace_id = $1 AND event = 'tier_assigned'`,
      [workspaceId],
    );
    expect(events.rows.length).toBe(1);
  }, 30_000);

  it('blocks tier assignment when workspace has an active execution lease', async () => {
    const workspaceId = 'ws-test-lease-lock-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const future = new Date(Date.now() + 60_000).toISOString();
    await pgRun(
      control.db,
      `UPDATE ${control.db.table('workspaces')} SET execution_lease_until = $1 WHERE id = $2`,
      [future, workspaceId],
    );

    await expect(
      applyWorkspaceTier(control.db, {
        workspaceId,
        tierId: 'free',
        revision: 2,
        expectedGeneration: 0,
        actor: 'did:plc:admin',
        reason: 'Lease blocked',
        configuredRegionIds: configured,
      }),
    ).rejects.toThrow(/Workspace policy changed or execution is busy/);
  }, 30_000);

  it('syncs tier entitlements into tenant metadata and checks scheduler state', async () => {
    const workspaceId = 'ws-tenant-sync-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const effective = await resolveEffectiveEntitlements(
      control.db,
      workspaceId,
      configured,
    );

    await syncTierEntitlements(tenant.db, effective);

    const meta = await pgFirst<{
      monitor_limit: number;
      tier_id: string;
      entitlement_generation: number;
    }>(
      tenant.db,
      `SELECT monitor_limit, tier_id, entitlement_generation
       FROM ${tenant.db.table('workspace_metadata')} WHERE id = 1`,
    );
    expect(meta?.monitor_limit).toBe(effective.entitlements.monitors);
    expect(meta?.tier_id).toBe('free');
    expect(meta?.entitlement_generation).toBe(effective.generation);

    const schedState = await tierSchedulingState(tenant.db);
    expect(schedState.overLimit).toBe(false);
    expect(schedState.pausedMonitorCount).toBe(0);

    const policyTables = schedulerPolicyTables(true);
    expect(policyTables.monitorsTable).toBe('tier_schedulable_monitors');
    expect(policyTables.notificationServicesTable).toBe('tier_active_notification_services');
  }, 30_000);

  it('saves and reads workspace product limits with workspace locking', async () => {
    const workspaceId = 'ws-test-limits-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const limits = {
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['eu-west', 'us-east'] as const,
    };

    await saveWorkspaceProductLimits(control.db, workspaceId, limits as any);

    const saved = await savedWorkspaceProductLimits(control.db, workspaceId, configured);
    expect(saved.monitors).toBe(5);
    expect(saved.regions).toBe(2);
    expect(saved.allowedRegionIds).toEqual(['eu-west', 'us-east']);
  }, 30_000);

  it('manages scheduling controls and fleet/budget pauses', async () => {
    const stateInitial = await schedulingState(control.db);
    expect(stateInitial.paused).toBe(false);

    await setSchedulingPause(
      control.db,
      'fleet',
      true,
      'Maintenance',
      'did:plc:admin',
    );

    const stateFleetPaused = await schedulingState(control.db);
    expect(stateFleetPaused.paused).toBe(true);

    await setSchedulingPause(
      control.db,
      'fleet',
      false,
      'Maintenance complete',
      'did:plc:admin',
    );

    await recordBudgetPause(control.db, false, new Date());
    const stateBudgetPaused = await schedulingState(control.db);
    expect(stateBudgetPaused.paused).toBe(true);
    expect(stateBudgetPaused.automatic?.scope).toBe('budget');

    await recordBudgetPause(control.db, true, new Date());
    const stateCleared = await schedulingState(control.db);
    expect(stateCleared.paused).toBe(false);
  }, 30_000);

  it('meters native PostgreSQL statements and flushes usage with null row metrics', async () => {
    const workspaceId = 'ws-test-meter-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const metered = meterDatabase(control.db);
    await metered.db.query(`SELECT id FROM ${metered.db.table('workspaces')} WHERE id = $1`, [
      workspaceId,
    ]);

    expect(metered.usage.statements).toBe(1);
    expect(metered.usage.durationMs).toBeGreaterThanOrEqual(0);
    // Row metrics unavailable on PostgreSQL are explicitly distinguished as null
    expect(metered.usage.rowsRead).toBeNull();
    expect(metered.usage.rowsWritten).toBeNull();
    expect(metered.usage.storageBytes).toBeNull();

    await flushUsage(control.db, workspaceId, metered.usage);

    const usageRow = await pgFirst<{ checks: number; rows_read: number }>(
      control.db,
      `SELECT checks, rows_read FROM ${control.db.table('workspace_usage_daily')}
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(usageRow).toBeTruthy();
    expect(usageRow?.rows_read).toBe(0);
  }, 30_000);

  it('defers workspace purge while execution lease is active', async () => {
    const workspaceId = 'ws-test-purge-lease-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    const future = new Date(Date.now() + 60_000).toISOString();
    await pgRun(
      control.db,
      `UPDATE ${control.db.table('workspaces')} SET state = 'deleting', execution_lease_until = $1 WHERE id = $2`,
      [future, workspaceId],
    );

    const purged = await purgeWorkspaceData({ control: control.db }, workspaceId);
    expect(purged).toBe(false);

    const ws = await pgFirst<{ state: string }>(
      control.db,
      `SELECT state FROM ${control.db.table('workspaces')} WHERE id = $1`,
      [workspaceId],
    );
    expect(ws?.state).toBe('deleting');
  }, 30_000);

  it('purges workspace data and transitions state to deleted once lease expires', async () => {
    const workspaceId = 'ws-test-purge-complete-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    await flushUsage(control.db, workspaceId, {
      rowsRead: 100,
      rowsWritten: 50,
      storageBytes: 1024,
      statements: 10,
      durationMs: 25,
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    await pgRun(
      control.db,
      `UPDATE ${control.db.table('workspaces')} SET state = 'deleting', execution_lease_until = $1 WHERE id = $2`,
      [past, workspaceId],
    );

    const purged = await purgeWorkspaceData({ control: control.db }, workspaceId);
    expect(purged).toBe(true);

    const ws = await pgFirst<{ state: string; name: string }>(
      control.db,
      `SELECT state, name FROM ${control.db.table('workspaces')} WHERE id = $1`,
      [workspaceId],
    );
    expect(ws?.state).toBe('deleted');
    expect(ws?.name).toBe('Deleted workspace');

    const members = await control.db.query(
      `SELECT * FROM ${control.db.table('memberships')} WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(members.rows.length).toBe(0);

    const usage = await pgFirst<{ checks: number }>(
      control.db,
      `SELECT checks FROM ${control.db.table('workspace_usage_daily')} WHERE workspace_id = '__deleted__'`,
    );
    expect(usage).toBeTruthy();

    const events = await control.db.query(
      `SELECT * FROM ${control.db.table('workspace_events')} WHERE workspace_id = $1 AND event = 'workspace_deleted'`,
      [workspaceId],
    );
    expect(events.rows.length).toBe(1);

    const purgedAgain = await purgeWorkspaceData({ control: control.db }, workspaceId);
    expect(purgedAgain).toBe(true);
  }, 30_000);

  it('rejects purging an imported workspace', async () => {
    const workspaceId = 'ws-test-purge-imported-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    await pgRun(
      control.db,
      `INSERT INTO ${control.db.table('postgres_tenant_registry')}
        (source_database_id, schema_name, status, workspace_id, updated_at)
       VALUES ('3900c94a-82a0-4422-a5f8-1a56b781cea7', 'imported_schema', 'assigned', $1, NOW())`,
      [workspaceId],
    );

    await expect(
      purgeWorkspaceData({ control: control.db }, workspaceId),
    ).rejects.toThrow(/Imported data cannot be purged through workspace deletion/);
  }, 30_000);

  it('resolves workspace database using postgres catalog entry and identifies imports', async () => {
    const workspaceId = 'ws-tenant-sync-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    await pgRun(
      control.db,
      `INSERT INTO ${control.db.table('postgres_tenant_registry')}
        (source_database_id, schema_name, status, workspace_id, updated_at)
       VALUES ('tenant-db-01', '${tenant.schema}', 'assigned', $1, NOW())
       ON CONFLICT (source_database_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
      [workspaceId],
    );

    const resolved = await resolveWorkspaceDatabase(control.db, workspaceId, [tenant.catalogEntry]);
    expect(resolved.schema).toBe(tenant.schema);

    expect(await isImportedWorkspace(control.db, workspaceId, [tenant.catalogEntry])).toBe(false);
  }, 30_000);

  it('records notification delivery history on native PostgreSQL', async () => {
    const notifServiceId = 'notif-service-test-01';
    await pgRun(
      tenant.db,
      `INSERT INTO ${tenant.db.table('notification_services')}
        (id, name, provider, enabled, config, created_at, updated_at)
       VALUES ($1, 'Telegram Alerts', 'telegram', 1, '{}', NOW(), NOW())`,
      [notifServiceId],
    );

    await recordNotificationHistory(tenant.db, {
      notificationServiceId: notifServiceId,
      monitorId: null,
      monitorName: 'Production Service',
      monitorUrl: 'https://example.com',
      provider: 'telegram',
      kind: 'outage',
      status: 'sent',
      createdAt: new Date(),
      text: 'Production Service is down',
      externalUrl: null,
      error: null,
      preview: { subject: 'Service down' },
    });

    const rows = await tenant.db.query<{ id: string; provider: string; status: string }>(
      `SELECT id, provider, status FROM ${tenant.db.table('notification_history')}
       WHERE notification_service_id = $1`,
      [notifServiceId],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.provider).toBe('telegram');
    expect(rows.rows[0]!.status).toBe('sent');
  }, 30_000);
});
