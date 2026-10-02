import { describe, expect, it } from 'vitest';
import {
  budgetAllowsWork,
  dispatchDueTenants,
  enforceFreePolicy,
  recordWorkspaceUsage,
  runTenantJob,
} from './tenant-dispatch.js';
import { makeDatabase } from './testing.js';
import type { CoordinatorConfig } from './env.js';

function config(): CoordinatorConfig {
  return {
    db: makeDatabase().db,
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

describe('hosted tenant policy and metering', () => {
  it('bounds free tenants to three regions and fixed retention windows', () => {
    const result = enforceFreePolicy(config());
    expect(result.enabledRegionIds).toEqual(['eu-west', 'us-east', 'asia']);
    expect(result.detailedResultsRetentionDays).toBe(1);
    expect(result.dnsDiagnosticsRetentionDays).toBe(30);
  });

  it('aggregates query work per workspace and day', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite.exec(`CREATE TABLE workspace_usage_daily (
      workspace_id TEXT NOT NULL, day TEXT NOT NULL, checks INTEGER NOT NULL,
      rows_read INTEGER NOT NULL, rows_written INTEGER NOT NULL, storage_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, day)
    )`);
    const now = new Date('2026-10-02T12:00:00.000Z');
    await recordWorkspaceUsage(
      db,
      'workspace-a',
      now,
      {
        probes: { rowsRead: 4, rowsWritten: 2 },
        reports: { rowsRead: 3, rowsWritten: 1 },
      },
      3,
      900,
    );
    await recordWorkspaceUsage(
      db,
      'workspace-a',
      now,
      {
        probes: { rowsRead: 1, rowsWritten: 5 },
      },
      2,
      700,
    );
    expect(sqlite.prepare('SELECT * FROM workspace_usage_daily').all()).toEqual([
      expect.objectContaining({
        workspace_id: 'workspace-a',
        day: '2026-10-02',
        checks: 5,
        rows_read: 8,
        rows_written: 8,
        storage_bytes: 900,
      }),
    ]);
  });

  it('stops hosted work at the configured forecast ceiling while preserving the gate state', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite.exec(`CREATE TABLE service_controls (
      id INTEGER PRIMARY KEY, monthly_budget_usd REAL NOT NULL,
      admission_open INTEGER NOT NULL, external_monthly_cost_usd REAL NOT NULL
    );
    INSERT INTO service_controls VALUES (1, 20, 1, 16);
    CREATE TABLE workspace_usage_daily (
      workspace_id TEXT, day TEXT, rows_read INTEGER, rows_written INTEGER,
      storage_bytes INTEGER, PRIMARY KEY (workspace_id, day)
    );`);
    expect(await budgetAllowsWork(db, new Date('2026-10-02T12:00:00.000Z'))).toBe(false);
    expect(
      (
        sqlite.prepare('SELECT admission_open FROM service_controls WHERE id = 1').get() as {
          admission_open: number;
        }
      ).admission_open,
    ).toBe(0);
  });

  it('does not enqueue or purge the imported staging workspace', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite.exec(`
      CREATE TABLE service_controls (
        id INTEGER PRIMARY KEY, monthly_budget_usd REAL NOT NULL,
        admission_open INTEGER NOT NULL, max_workspaces INTEGER NOT NULL DEFAULT 10,
        external_monthly_cost_usd REAL NOT NULL
      );
      INSERT INTO service_controls VALUES (1, 20, 1, 10, 0);
      CREATE TABLE workspace_usage_daily (
        workspace_id TEXT, day TEXT, rows_read INTEGER, rows_written INTEGER,
        storage_bytes INTEGER, PRIMARY KEY (workspace_id, day)
      );
      CREATE TABLE request_budgets (key TEXT PRIMARY KEY, window_started_at TEXT, count INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, next_dispatch_at TEXT,
        updated_at TEXT NOT NULL, execution_lease_token TEXT, execution_lease_until TEXT
      );
      CREATE TABLE tenant_slots (
        binding_name TEXT PRIMARY KEY, workspace_id TEXT, database_id TEXT, status TEXT
      );
      CREATE TABLE dispatch_outbox (
        id TEXT PRIMARY KEY, workspace_id TEXT, scheduled_at TEXT, status TEXT,
        attempts INTEGER, next_attempt_at TEXT, created_at TEXT, dispatched_at TEXT, last_error TEXT
      );
      INSERT INTO workspaces VALUES ('00000000-0000-4000-8000-000000000001', 'active', '2026-10-03T00:00:00.000Z', '2026-10-02T00:00:00.000Z', NULL, NULL);
      INSERT INTO tenant_slots VALUES ('STAGING_IMPORTED_DB', '00000000-0000-4000-8000-000000000001', '3900c94a-82a0-4422-a5f8-1a56b781cea7', 'assigned');
    `);
    const sent: unknown[] = [];
    const env = {
      CONTROL_DB: db,
      ENVIRONMENT: 'staging',
      TENANT_JOBS: { send: async (job: unknown) => void sent.push(job) },
    } as never;
    const result = await dispatchDueTenants(env, new Date('2026-10-03T00:01:00.000Z'));
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('drops stale imported jobs before taking a lease', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, next_dispatch_at TEXT,
        updated_at TEXT NOT NULL, execution_lease_token TEXT, execution_lease_until TEXT
      );
      CREATE TABLE tenant_slots (
        binding_name TEXT PRIMARY KEY, workspace_id TEXT, database_id TEXT, status TEXT
      );
      INSERT INTO workspaces VALUES ('00000000-0000-4000-8000-000000000002', 'active', NULL, '2026-10-02T00:00:00.000Z', NULL, NULL);
      INSERT INTO tenant_slots VALUES ('STAGING_IMPORTED_DB', '00000000-0000-4000-8000-000000000002', '3900c94a-82a0-4422-a5f8-1a56b781cea7', 'assigned');
    `);
    await runTenantJob({ CONTROL_DB: db, ENVIRONMENT: 'staging' } as never, {
      workspaceId: '00000000-0000-4000-8000-000000000002',
      scheduledAt: '2026-10-03T00:00:00.000Z',
    });
    expect(sqlite.prepare('SELECT execution_lease_token FROM workspaces').get()).toEqual({
      execution_lease_token: null,
    });
  });

  it('does not apply the staging bypass in production', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite.exec(`
      CREATE TABLE service_controls (
        id INTEGER PRIMARY KEY, monthly_budget_usd REAL NOT NULL,
        admission_open INTEGER NOT NULL, max_workspaces INTEGER NOT NULL DEFAULT 10,
        external_monthly_cost_usd REAL NOT NULL
      );
      INSERT INTO service_controls VALUES (1, 20, 1, 10, 0);
      CREATE TABLE workspace_usage_daily (
        workspace_id TEXT, day TEXT, rows_read INTEGER, rows_written INTEGER,
        storage_bytes INTEGER, PRIMARY KEY (workspace_id, day)
      );
      CREATE TABLE request_budgets (key TEXT PRIMARY KEY, window_started_at TEXT, count INTEGER);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, state TEXT NOT NULL, next_dispatch_at TEXT, updated_at TEXT NOT NULL, execution_lease_token TEXT, execution_lease_until TEXT);
      CREATE TABLE tenant_slots (binding_name TEXT PRIMARY KEY, workspace_id TEXT, database_id TEXT, status TEXT);
      CREATE TABLE dispatch_outbox (id TEXT PRIMARY KEY, workspace_id TEXT, scheduled_at TEXT, status TEXT, attempts INTEGER, next_attempt_at TEXT, created_at TEXT, dispatched_at TEXT, last_error TEXT, UNIQUE (workspace_id, scheduled_at));
      INSERT INTO workspaces VALUES ('00000000-0000-4000-8000-000000000003', 'active', '2026-10-03T00:00:00.000Z', '2026-10-02T00:00:00.000Z', NULL, NULL);
      INSERT INTO tenant_slots VALUES ('STAGING_IMPORTED_DB', '00000000-0000-4000-8000-000000000003', '3900c94a-82a0-4422-a5f8-1a56b781cea7', 'assigned');
    `);
    const sent: unknown[] = [];
    const result = await dispatchDueTenants(
      {
        CONTROL_DB: db,
        ENVIRONMENT: 'production',
        TENANT_JOBS: { send: async (job: unknown) => void sent.push(job) },
      } as never,
      new Date('2026-10-03T00:01:00.000Z'),
    );
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
