import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeWorkspaceData } from './tenant-lifecycle.js';
import type { R2Bucket, R2Object, R2Objects } from './workers-types.js';
import {
  createControlFixture,
  createTenantFixture,
  grantTenantAccessToControl,
  seedControlUserAndWorkspace,
  seedTenantIdentity,
  type ControlTestFixture,
  type TenantTestFixture,
} from './testing/postgres-fixtures.js';
import { pgFirst, pgRun } from './postgres/query.js';

const TEST_URL = process.env.POSTGRES_TEST_ADMIN_URL;
const describePg = TEST_URL ? describe : describe.skip;

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
    const prefix = options?.prefix ?? '';
    const matching = [...this.keys].filter((key) => key.startsWith(prefix));
    const limit = options?.limit ?? 1000;
    const page = matching.slice(0, limit);
    const objects = page.map((key) => ({
      key,
      size: 0,
      etag: 'tag',
      httpEtag: 'tag',
      uploaded: new Date(),
      version: '1',
    }));
    if (matching.length > limit) {
      return {
        objects,
        truncated: true,
        cursor: 'next',
      };
    }
    return {
      objects,
      truncated: false,
    };
  }
}

describePg('purgeWorkspaceData (native PostgreSQL)', () => {
  let control: ControlTestFixture;
  let tenant: TenantTestFixture;
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const ownerDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

  beforeAll(async () => {
    control = await createControlFixture();
    tenant = await createTenantFixture('tenant-db-purge-01', 'full-hosted');
    await grantTenantAccessToControl(control, tenant);
    await seedControlUserAndWorkspace(control.db, { workspaceId, ownerDid });
    await seedTenantIdentity(tenant.db, { workspaceId, sourceDatabaseId: 'tenant-db-purge-01' });
    await pgRun(
      control.db,
      `INSERT INTO ${control.db.table('postgres_tenant_registry')}
        (source_database_id, schema_name, status, workspace_id, updated_at)
       VALUES ('tenant-db-purge-01', '${tenant.schema}', 'assigned', $1, NOW())
       ON CONFLICT (source_database_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
      [workspaceId],
    );
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([control?.close(), tenant?.close()]);
  }, 60_000);

  it('does nothing while an execution lease is live', async () => {
    const future = '2099-01-01T00:00:00.000Z';
    await pgRun(
      control.db,
      `UPDATE ${control.db.table('workspaces')} SET state = 'deleting', execution_lease_until = $1 WHERE id = $2`,
      [future, workspaceId],
    );

    const reports = new MemoryR2([`tenants/${workspaceId}/public/0.json`]);
    const purged = await purgeWorkspaceData(
      { control: control.db, catalog: [tenant.catalogEntry], reports },
      workspaceId,
      new Date('2026-10-02T12:00:00.000Z'),
    );
    expect(purged).toBe(false);

    const ws = await pgFirst<{ state: string }>(
      control.db,
      `SELECT state FROM ${control.db.table('workspaces')} WHERE id = $1`,
      [workspaceId],
    );
    expect(ws?.state).toBe('deleting');
  }, 30_000);

  it('clears tenant data and reports after lease expiry', async () => {
    const past = '2026-10-02T11:59:59.000Z';
    await pgRun(
      control.db,
      `UPDATE ${control.db.table('workspaces')} SET state = 'deleting', execution_lease_until = $1 WHERE id = $2`,
      [past, workspaceId],
    );

    const reports = new MemoryR2([
      `tenants/${workspaceId}/public/0.json`,
      'tenants/other/public/a.json',
    ]);

    const purged = await purgeWorkspaceData(
      { control: control.db, catalog: [tenant.catalogEntry], reports },
      workspaceId,
      new Date('2026-10-02T12:00:00.000Z'),
    );
    expect(purged).toBe(true);

    const ws = await pgFirst<{ state: string; name: string }>(
      control.db,
      `SELECT state, name FROM ${control.db.table('workspaces')} WHERE id = $1`,
      [workspaceId],
    );
    expect(ws?.state).toBe('deleted');
    expect(ws?.name).toBe('Deleted workspace');

    // Reports cleared for this workspace, but intact for other
    expect(await reports.list({ prefix: `tenants/${workspaceId}/` })).toMatchObject({
      objects: [],
    });
    expect(await reports.list({ prefix: 'tenants/other/' })).toMatchObject({
      objects: [{ key: 'tenants/other/public/a.json' }],
    });
  }, 30_000);

  it('is idempotent after the workspace is deleted', async () => {
    const purged = await purgeWorkspaceData(
      { control: control.db, catalog: [tenant.catalogEntry] },
      workspaceId,
      new Date('2026-10-02T12:01:00.000Z'),
    );
    expect(purged).toBe(true);
  }, 30_000);
});
