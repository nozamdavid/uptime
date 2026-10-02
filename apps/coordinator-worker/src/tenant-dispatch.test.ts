import { describe, expect, it } from 'vitest';
import { budgetAllowsWork, enforceFreePolicy, recordWorkspaceUsage } from './tenant-dispatch.js';
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
});
