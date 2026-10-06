import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultProductLimits,
  savedWorkspaceProductLimits,
  saveWorkspaceProductLimits,
  syncWorkspaceProductLimits,
  workspaceProductLimits,
} from './product-limits.js';
import {
  createControlFixture,
  createTenantFixture,
  seedControlUserAndWorkspace,
  seedTenantIdentity,
  type ControlTestFixture,
  type TenantTestFixture,
} from './testing/postgres-fixtures.js';
import { pgFirst } from './postgres/query.js';

const TEST_URL = process.env.POSTGRES_TEST_ADMIN_URL;
const describePg = TEST_URL ? describe : describe.skip;

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

describe('defaultProductLimits (pure)', () => {
  it('selects preferred regions up to 3', () => {
    expect(defaultProductLimits(configured)).toEqual({
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['eu-west', 'us-east', 'asia'],
    });
  });

  it('selects available regions when preferred are missing', () => {
    expect(defaultProductLimits(['canada-central', 'eu-north'])).toEqual({
      monitors: 3,
      regions: 2,
      allowedRegionIds: ['canada-central', 'eu-north'],
    });
  });

  it('throws when no regions are configured', () => {
    expect(() => defaultProductLimits([])).toThrow(/configured/);
  });
});

describePg('workspace product limits (native PostgreSQL)', () => {
  let control: ControlTestFixture;
  let tenant: TenantTestFixture;

  beforeAll(async () => {
    control = await createControlFixture();
    tenant = await createTenantFixture('tenant-limits-01', 'full-hosted');
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([control?.close(), tenant?.close()]);
  }, 60_000);

  it('uses preferred defaults and isolates persisted overrides by workspace', async () => {
    await seedControlUserAndWorkspace(control.db, { workspaceId: 'workspace-a' });
    await seedControlUserAndWorkspace(control.db, { workspaceId: 'workspace-b' });

    expect(await workspaceProductLimits(control.db, 'workspace-a', configured)).toEqual({
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['eu-west', 'us-east', 'asia'],
    });

    await saveWorkspaceProductLimits(control.db, 'workspace-a', {
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['us-west', 'eu-north'],
    });

    expect(await workspaceProductLimits(control.db, 'workspace-a', configured)).toEqual({
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['us-west', 'eu-north'],
    });

    expect(await workspaceProductLimits(control.db, 'workspace-b', configured)).toEqual({
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['eu-west', 'us-east', 'asia'],
    });

    expect(await savedWorkspaceProductLimits(control.db, 'workspace-a', configured)).toEqual({
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['us-west', 'eu-north'],
    });

    await seedTenantIdentity(tenant.db, {
      workspaceId: 'workspace-a',
      sourceDatabaseId: 'tenant-limits-01',
    });
    const limits = await workspaceProductLimits(control.db, 'workspace-a', configured);
    await syncWorkspaceProductLimits(tenant.db, limits);

    const meta = await pgFirst<{ monitor_limit: number; region_limit: number }>(
      tenant.db,
      `SELECT monitor_limit, region_limit FROM ${tenant.db.table('workspace_metadata')} WHERE id = 1`,
    );
    expect(meta?.monitor_limit).toBe(5);
    expect(meta?.region_limit).toBe(2);
  }, 30_000);

  it('keeps stale saved policies readable for repair while strict reads reject dispatch', async () => {
    const workspaceId = 'workspace-stale';
    await seedControlUserAndWorkspace(control.db, { workspaceId });

    await saveWorkspaceProductLimits(control.db, workspaceId, {
      monitors: 4,
      regions: 2,
      allowedRegionIds: ['eu-west', 'us-east'],
    });

    const activeSubset = ['eu-west'] as const;
    expect(await savedWorkspaceProductLimits(control.db, workspaceId, activeSubset)).toEqual({
      monitors: 4,
      regions: 2,
      allowedRegionIds: ['eu-west', 'us-east'],
    });

    await expect(workspaceProductLimits(control.db, workspaceId, activeSubset)).rejects.toThrow(
      /configured regions|includes a region that is not configured/,
    );
  }, 30_000);
});
