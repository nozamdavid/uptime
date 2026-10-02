import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { createD1Adapter, createTestDatabase } from './testing/sqlite.js';
import { purgeWorkspaceData } from './tenant-lifecycle.js';
import type { R2Bucket, R2Object, R2Objects } from './workers-types.js';

const controlSchema = readFileSync(
  new URL('./control-migrations/0001_control.sql', import.meta.url),
  'utf8',
);
const databases: ReturnType<typeof createTestDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('purgeWorkspaceData', () => {
  it('does nothing while an execution lease is live', async () => {
    const fixture = createFixture('2099-01-01T00:00:00.000Z');
    const purged = await purgeWorkspaceData(
      fixture.env,
      fixture.workspaceId,
      new Date('2026-10-02T12:00:00.000Z'),
    );
    expect(purged).toBe(false);
    expect(fixture.tenant.prepare('SELECT count(*) AS count FROM monitors').get()).toEqual({
      count: 1,
    });
    expect(await fixture.reports.list({ prefix: `tenants/${fixture.workspaceId}/` })).toMatchObject(
      { objects: [{ key: `tenants/${fixture.workspaceId}/public/0.json` }] },
    );
  });

  it('clears tenant data and only the workspace R2 namespace after lease expiry', async () => {
    const fixture = createFixture('2026-10-02T11:59:59.000Z');
    fixture.control
      .prepare(
        'INSERT INTO workspace_usage_daily(workspace_id,day,checks,rows_read,rows_written,storage_bytes,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(fixture.workspaceId, '2026-10-01', 3, 200, 100, 500, '2026-10-01T12:00:00.000Z');
    const purged = await purgeWorkspaceData(
      fixture.env,
      fixture.workspaceId,
      new Date('2026-10-02T12:00:00.000Z'),
    );
    expect(purged).toBe(true);
    expect(fixture.tenant.prepare('SELECT count(*) AS count FROM monitors').get()).toEqual({
      count: 0,
    });
    expect(
      fixture.tenant.prepare('SELECT workspace_id FROM workspace_metadata WHERE id = 1').get(),
    ).toEqual({ workspace_id: fixture.workspaceId });
    expect(await fixture.reports.list({ prefix: `tenants/${fixture.workspaceId}/` })).toMatchObject(
      { objects: [] },
    );
    expect(await fixture.reports.list({ prefix: 'tenants/other/' })).toMatchObject({
      objects: [{ key: 'tenants/other/public/a.json' }],
    });
    expect(
      fixture.control
        .prepare('SELECT state, name FROM workspaces WHERE id = ?')
        .get(fixture.workspaceId),
    ).toEqual({ state: 'deleted', name: 'Deleted workspace' });
    expect(
      fixture.control
        .prepare('SELECT count(*) AS count FROM memberships WHERE workspace_id = ?')
        .get(fixture.workspaceId),
    ).toEqual({ count: 0 });
    expect(
      fixture.control.prepare('SELECT did FROM users WHERE did = ?').get(fixture.ownerDid),
    ).toEqual({ did: fixture.ownerDid });
    expect(
      fixture.control
        .prepare(
          "SELECT workspace_id, actor_did FROM workspace_events WHERE event = 'workspace_deleted'",
        )
        .get(),
    ).toEqual({ workspace_id: fixture.workspaceId, actor_did: fixture.ownerDid });
    expect(
      fixture.control
        .prepare(
          'SELECT workspace_id,checks,rows_read,rows_written,storage_bytes FROM workspace_usage_daily',
        )
        .all(),
    ).toEqual([
      {
        workspace_id: '__deleted__',
        checks: 3,
        rows_read: 200,
        rows_written: 100,
        storage_bytes: 0,
      },
    ]);
  });

  it('is idempotent after the workspace is deleted', async () => {
    const fixture = createFixture('2026-10-02T11:59:59.000Z');
    expect(
      await purgeWorkspaceData(
        fixture.env,
        fixture.workspaceId,
        new Date('2026-10-02T12:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      await purgeWorkspaceData(
        fixture.env,
        fixture.workspaceId,
        new Date('2026-10-02T12:01:00.000Z'),
      ),
    ).toBe(true);
    expect(
      fixture.control
        .prepare("SELECT count(*) AS count FROM workspace_events WHERE event = 'workspace_deleted'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it('defers final deletion when more than three R2 batches remain', async () => {
    const fixture = createFixture('2026-10-02T11:59:59.000Z', 3_001);
    expect(
      await purgeWorkspaceData(
        fixture.env,
        fixture.workspaceId,
        new Date('2026-10-02T12:00:00.000Z'),
      ),
    ).toBe(false);
    expect(fixture.tenant.prepare('SELECT count(*) AS count FROM monitors').get()).toEqual({
      count: 0,
    });
    expect(
      fixture.control.prepare('SELECT state FROM workspaces WHERE id = ?').get(fixture.workspaceId),
    ).toEqual({ state: 'deleting' });
  });
});

function createFixture(leaseUntil: string, reportCount = 1) {
  const control = createTestDatabase();
  const tenant = createTestDatabase();
  databases.push(control, tenant);
  control.exec(controlSchema);
  ensureLeaseColumns(control);
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const ownerDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const timestamp = '2026-10-01T00:00:00.000Z';
  control
    .prepare(
      'INSERT INTO users(did, handle, state, created_at, updated_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)',
    )
    .run(ownerDid, 'owner.bsky.social', 'active', timestamp, timestamp, timestamp);
  control
    .prepare(
      `INSERT INTO workspaces(id, owner_did, name, state, plan, created_at, updated_at, execution_lease_token, execution_lease_until)
    VALUES(?, ?, 'Workspace', 'deleting', 'free', ?, ?, 'lease', ?)`,
    )
    .run(workspaceId, ownerDid, timestamp, timestamp, leaseUntil);
  control
    .prepare(
      "INSERT INTO memberships(workspace_id, did, role, created_at) VALUES(?, ?, 'owner', ?)",
    )
    .run(workspaceId, ownerDid, timestamp);
  control
    .prepare(
      "INSERT INTO tenant_slots(binding_name, workspace_id, database_id, status) VALUES('TENANT_ONE', ?, 'tenant-one', 'assigned')",
    )
    .run(workspaceId);
  tenant
    .prepare("INSERT INTO workspace_metadata(id, workspace_id, plan) VALUES(1, ?, 'free')")
    .run(workspaceId);
  tenant
    .prepare(
      `INSERT INTO monitors(id, name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled, uptime_thresholds, outage_threshold, recovery_threshold, next_check_at)
    VALUES('10000000-0000-4000-8000-000000000001', 'Monitor', 'https://example.com', 300, 10000, 1, 0, '{}', 2, 1, ?)`,
    )
    .run(timestamp);
  const reports = new MemoryR2([
    ...Array.from(
      { length: reportCount },
      (_value, index) => `tenants/${workspaceId}/public/${index}.json`,
    ),
    'tenants/other/public/a.json',
  ]);
  return {
    control,
    tenant,
    reports,
    workspaceId,
    ownerDid,
    env: {
      CONTROL_DB: createD1Adapter(control),
      TENANT_ONE: createD1Adapter(tenant),
      REPORTS: reports,
    },
  };
}

function ensureLeaseColumns(control: ReturnType<typeof createTestDatabase>) {
  const columns = control.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'execution_lease_token'))
    control.exec('ALTER TABLE workspaces ADD COLUMN execution_lease_token TEXT');
  if (!columns.some((column) => column.name === 'execution_lease_until'))
    control.exec('ALTER TABLE workspaces ADD COLUMN execution_lease_until TEXT');
}

class MemoryR2 implements R2Bucket {
  private readonly keys: Set<string>;
  constructor(keys: string[]) {
    this.keys = new Set(keys);
  }
  async head(): Promise<R2Object | null> {
    return null;
  }
  async get(): Promise<null> {
    return null;
  }
  async put(): Promise<R2Object | null> {
    return null;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.keys.delete(key);
  }
  async list(options?: { prefix?: string; limit?: number }): Promise<R2Objects> {
    const all = [...this.keys].filter((key) => key.startsWith(options?.prefix ?? '')).sort();
    const selected = all.slice(0, options?.limit ?? 1000);
    return {
      objects: selected.map((key) => ({
        key,
        version: '1',
        size: 0,
        etag: 'e',
        uploaded: new Date(0),
      })),
      truncated: selected.length < all.length,
    };
  }
}
