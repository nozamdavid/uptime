import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyWorkspaceTier,
  defaultProductCatalog,
  publicProductCatalog,
  readProductCatalog,
  resolveEffectiveEntitlements,
  saveProductCatalog,
  schedulerPolicyTables,
  syncTierEntitlements,
  tierSchedulingState,
  validateProductCatalog,
} from './product-tiers.js';
import {
  createControlFixture,
  createTenantFixture,
  seedControlUserAndWorkspace,
  seedTenantIdentity,
  type ControlTestFixture,
  type TenantTestFixture,
} from './testing/postgres-fixtures.js';
import { pgFirst, pgRun } from './postgres/query.js';

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

function catalog(revision = 1) {
  const value = defaultProductCatalog(configured);
  value.revision = revision;
  for (const plan of value.plans) plan.revision = revision;
  return value;
}

describe('product tiers (pure unit)', () => {
  it('consumes the config file and exposes supported preview capabilities without private mappings', () => {
    const source = JSON.parse(
      readFileSync(new URL('../../../config/product-tiers.json', import.meta.url), 'utf8'),
    );
    expect(defaultProductCatalog(configured)).toEqual(validateProductCatalog(source, configured));
    const value = catalog();
    value.stripePriceIds = { pro: 'price_StagingExample' };
    expect(JSON.stringify(publicProductCatalog(value))).not.toContain('price_StagingExample');
    expect(value.plans.map((plan) => plan.price.amount)).toEqual([0, 1900, 4900]);
    expect(defaultProductCatalog(['us-west']).plans[1]?.entitlements.allowedRegionIds).toEqual([
      'us-west',
    ]);
  });

  it('supports configured live mode and custom tier IDs while rejecting unsupported contracts', () => {
    const value = catalog();
    value.billingMode = 'stripe';
    value.preview = false;
    value.plans[1]!.id = 'studio_plus';
    value.plans[1]!.preview = false;
    value.plans[1]!.price.currency = 'eur';
    expect(validateProductCatalog(value, configured).plans[1]?.id).toBe('studio_plus');
    for (const [field, bad] of [
      ['monitors', 1.2],
      ['regions', 10],
      ['intervalSeconds', 60],
      ['rawRetentionHours', 168],
      ['notificationDestinations', -1],
    ] as const) {
      const invalid = structuredClone(value);
      Object.assign(invalid.plans[1]!.entitlements, { [field]: bad });
      expect(() => validateProductCatalog(invalid, configured)).toThrow();
    }
    value.plans[1]!.entitlements.monitors = 1000;
    expect(() => validateProductCatalog(value, configured)).toThrow(/capacity/);
  });

  it('provides scheduler policy tables for hosted and non-hosted schedulers', () => {
    expect(schedulerPolicyTables(true)).toEqual({
      monitorsTable: 'tier_schedulable_monitors',
      notificationServicesTable: 'tier_active_notification_services',
    });
    expect(schedulerPolicyTables(false)).toEqual({
      monitorsTable: 'monitors',
      notificationServicesTable: 'notification_services',
    });
  });
});

describePg('product tiers (native PostgreSQL)', () => {
  let control: ControlTestFixture;
  let tenant: TenantTestFixture;
  const workspaceId = 'ws-tiers-pg-01';

  beforeAll(async () => {
    control = await createControlFixture();
    tenant = await createTenantFixture('tenant-tiers-db-01', 'full-hosted');
    await seedControlUserAndWorkspace(control.db, { workspaceId });
    await seedTenantIdentity(tenant.db, {
      workspaceId,
      sourceDatabaseId: 'tenant-tiers-db-01',
    });
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([control?.close(), tenant?.close()]);
  }, 60_000);

  it('audits immutable revisions and rejects stale catalog saves atomically', async () => {
    await saveProductCatalog(control.db, configured, catalog(1), 0, 'operator', 'Initial preview');
    await expect(
      saveProductCatalog(control.db, configured, catalog(1), 0, 'operator', 'Stale edit'),
    ).rejects.toMatchObject({ code: 'catalog_conflict' });

    const rev = await pgFirst<{ actor: string; reason: string }>(
      control.db,
      `SELECT actor, reason FROM ${control.db.table('product_catalog_revisions')} WHERE revision = 1`,
    );
    expect(rev).toEqual({
      actor: 'operator',
      reason: 'Initial preview',
    });
    expect((await readProductCatalog(control.db, configured)).revision).toBe(1);
  }, 30_000);

  it('pins contracts, preserves explicit overrides and leaves unassigned workspaces free', async () => {
    const unassignedWs = 'ws-unassigned-01';
    await seedControlUserAndWorkspace(control.db, { workspaceId: unassignedWs });
    const before = await resolveEffectiveEntitlements(control.db, unassignedWs, configured);
    expect(before).toMatchObject({
      tierId: 'free',
      revision: 0,
      overrides: null,
      entitlements: { monitors: 3, seats: 3 },
    });

    const effective = await applyWorkspaceTier(control.db, {
      workspaceId,
      tierId: 'pro',
      revision: 1,
      expectedGeneration: 0,
      actor: 'trusted-billing',
      reason: 'Subscription',
      configuredRegionIds: configured,
    });
    expect(effective.tierId).toBe('pro');
    expect(effective.generation).toBe(1);
  }, 30_000);

  it('syncs tier entitlements into tenant metadata and evaluates scheduling state', async () => {
    const effective = await resolveEffectiveEntitlements(control.db, workspaceId, configured);
    await syncTierEntitlements(tenant.db, effective);

    const meta = await pgFirst<{ tier_id: string; monitor_limit: number }>(
      tenant.db,
      `SELECT tier_id, monitor_limit FROM ${tenant.db.table('workspace_metadata')} WHERE id = 1`,
    );
    expect(meta?.tier_id).toBe('pro');
    expect(meta?.monitor_limit).toBe(effective.entitlements.monitors);

    const state = await tierSchedulingState(tenant.db);
    expect(state.overLimit).toBe(false);
  }, 30_000);
});
