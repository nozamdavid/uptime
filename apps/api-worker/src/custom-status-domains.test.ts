import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Database, pgAll, pgFirst, pgRun } from '@uptime/cloudflare/postgres';
import {
  seedControlUser,
  seedControlWorkspace,
  type ControlTestFixture,
} from './testing/control-fixture.js';
import { createRuntimeFixture } from './testing/runtime-fixture.js';

import {
  createCustomDomainProvider,
  CustomDomainProviderError,
  type CustomDomainProvider,
} from './custom-domain-provider.js';
import {
  CustomStatusDomainError,
  CustomStatusDomainService,
  type CustomStatusDomainActorContext,
} from './custom-status-domains.js';

interface TenantFixtureRef {
  readonly db: Database;
  readonly fixture: {
    readonly adminDb: {
      query(sql: string, values?: unknown[]): Promise<unknown>;
    };
  };
}

describe('CustomStatusDomainService (PostgreSQL Native)', { timeout: 120_000 }, () => {
  const testNow = 1_700_000_000_000;
  const nowIso = new Date(testNow).toISOString();

  let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;
  let controlFixture: ControlTestFixture;
  let tenant1Fixture: TenantFixtureRef;
  let tenant2Fixture: TenantFixtureRef;

  beforeAll(async () => {
    fixture = await createRuntimeFixture(['full-hosted', 'full-hosted']);
    controlFixture = fixture.control;
    tenant1Fixture = { db: fixture.tenants[0]!.db, fixture: fixture.tenants[0]! };
    tenant2Fixture = { db: fixture.tenants[1]!.db, fixture: fixture.tenants[1]! };
  }, 180_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  afterEach(async () => {
    // Reset test data in disposable schemas between tests using adminDb
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('custom_status_domains')}`,
    );
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('workspace_events')}`,
    );
    await controlFixture.fixture.adminDb.query(
      `UPDATE ${controlFixture.db.table('tenant_slots')} SET workspace_id = NULL, status = 'available'`,
    );
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('tenant_slots')} WHERE database_id NOT IN ('source-1', 'source-2')`,
    );
    await controlFixture.fixture.adminDb.query(
      `UPDATE ${controlFixture.db.table('postgres_tenant_registry')} SET workspace_id = NULL, status = 'available'`,
    );
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('postgres_tenant_registry')} WHERE source_database_id NOT IN ('source-1', 'source-2')`,
    );
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('memberships')}`,
    );
    await controlFixture.fixture.adminDb.query(
      `DELETE FROM ${controlFixture.db.table('workspaces')}`,
    );
    await controlFixture.fixture.adminDb.query(`DELETE FROM ${controlFixture.db.table('users')}`);
    await tenant1Fixture.fixture.adminDb.query(
      `DELETE FROM ${tenant1Fixture.db.table('status_pages')}`,
    );
    await tenant2Fixture.fixture.adminDb.query(
      `DELETE FROM ${tenant2Fixture.db.table('status_pages')}`,
    );
  }, 120_000);

  async function seedWorkspace(
    control: Database,
    workspaceId: string,
    ownerDid: string,
    state: 'active' | 'suspended' | 'deleting' | 'deleted' = 'active',
  ) {
    await seedControlUser(control, ownerDid, `${ownerDid}.handle`, nowIso);
    await seedControlWorkspace(control, {
      workspaceId,
      ownerDid,
      state,
      name: `Workspace ${workspaceId}`,
      timestamp: nowIso,
    });
  }

  async function seedMember(
    control: Database,
    workspaceId: string,
    memberDid: string,
    role = 'viewer',
    userState = 'active',
  ) {
    await pgRun(
      control,
      `INSERT INTO ${control.table('users')} (did, handle, state, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $4, $4)
       ON CONFLICT (did) DO UPDATE SET state = EXCLUDED.state`,
      [memberDid, `${memberDid}.handle`, userState, nowIso],
    );
    await pgRun(
      control,
      `INSERT INTO ${control.table('memberships')} (workspace_id, did, role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, did) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, memberDid, role, nowIso],
    );
  }

  async function seedStatusPage(
    tenantDb: Database,
    pageId: string,
    publicSlug: string | null,
    title = 'Production Status',
  ) {
    await pgRun(
      tenantDb,
      `INSERT INTO ${tenantDb.table('status_pages')} (id, title, public_slug, report_interval_seconds, created_at, updated_at)
       VALUES ($1, $2, $3, 60, $4, $4)`,
      [pageId, title, publicSlug, nowIso],
    );
  }

  // -------------------------------------------------------------------------
  // 1. Authorization and Trust Boundary Tests
  // -------------------------------------------------------------------------

  it('enforces owner-only authorization on mutations while allowing members to list', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedMember(control, 'ws-1', 'did:member', 'viewer');
    await seedStatusPage(tenant, 'page-1', 'public-slug-1');

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const viewerContext: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:member',
      role: 'viewer',
    };

    const ownerContext: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    // Viewer cannot create
    await expect(
      service.create(viewerContext, {
        statusPageId: 'page-1',
        hostname: 'status.example.com',
      }),
    ).rejects.toThrow('Only workspace owners can manage custom domains');

    // Owner can create
    const created = await service.create(ownerContext, {
      statusPageId: 'page-1',
      hostname: 'status.example.com',
    });
    expect(created.hostname).toBe('status.example.com');
    expect(created.status).toBe('pending');
    expect(created.eligibilityReason).toBeDefined();

    // Viewer cannot refresh
    await expect(service.refresh(viewerContext, created.id)).rejects.toThrow(
      'Only workspace owners can manage custom domains',
    );

    // Viewer cannot remove
    await expect(service.remove(viewerContext, created.id)).rejects.toThrow(
      'Only workspace owners can manage custom domains',
    );

    // Viewer CAN list and response includes mode/ready/setupReasons/simulation
    const listResult = await service.list(viewerContext);
    expect(listResult.domains).toHaveLength(1);
    expect(listResult.domains[0]?.hostname).toBe('status.example.com');
    expect(listResult.mode).toBe('mock');
    expect(listResult.ready).toBe(true);
    expect(listResult.setupReasons).toEqual([]);
    expect(listResult.simulation).toBe(true);
  });

  it('rejects cross-workspace spoofed roles and inactive users via PostgreSQL verification', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-victim', 'did:victim-owner');
    await seedWorkspace(control, 'ws-attacker', 'did:attacker');
    await seedMember(control, 'ws-victim', 'did:suspended-user', 'owner', 'suspended');
    await seedMember(control, 'ws-victim', 'did:db-viewer', 'viewer');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    // Attacker claims role: 'owner' for victim workspace, but DB has no membership for attacker in ws-victim
    await expect(
      service.create(
        { workspaceId: 'ws-victim', actorDid: 'did:attacker', role: 'owner' },
        { statusPageId: 'page-1', hostname: 'status.spoof.com' },
      ),
    ).rejects.toThrow('Workspace membership required');

    // Suspended user claiming owner role is rejected
    await expect(
      service.create(
        { workspaceId: 'ws-victim', actorDid: 'did:suspended-user', role: 'owner' },
        { statusPageId: 'page-1', hostname: 'status.spoof.com' },
      ),
    ).rejects.toThrow('Active user required');

    // Viewer in DB claims role: 'owner' in request context -> DB role is checked and rejected
    await expect(
      service.create(
        { workspaceId: 'ws-victim', actorDid: 'did:db-viewer', role: 'owner' },
        { statusPageId: 'page-1', hostname: 'status.spoof.com' },
      ),
    ).rejects.toThrow('Only workspace owners can manage custom domains');
  });

  // -------------------------------------------------------------------------
  // 2. Status Page Publication and Validation Tests
  // -------------------------------------------------------------------------

  it('rejects unclaimable, non-existent, or private status pages', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-public', 'public-slug');
    await seedStatusPage(tenant, 'page-private', null);

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const ownerContext: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    // Unknown status page
    await expect(
      service.create(ownerContext, {
        statusPageId: 'page-unknown',
        hostname: 'status.example.com',
      }),
    ).rejects.toThrow('Status page not found');

    // Private status page
    await expect(
      service.create(ownerContext, {
        statusPageId: 'page-private',
        hostname: 'status.example.com',
      }),
    ).rejects.toThrow('Status page must be published with a public slug to attach a custom domain');
  });

  it('supports cross-workspace colliding status page IDs without collision or leakage', async () => {
    const control = controlFixture.db;
    const tenant1 = tenant1Fixture.db;
    const tenant2 = tenant2Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner1');
    await seedWorkspace(control, 'ws-2', 'did:owner2');

    await seedStatusPage(tenant1, 'page-common', 'slug-tenant-1');
    await seedStatusPage(tenant2, 'page-common', 'slug-tenant-2');

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: (wsId) => (wsId === 'ws-1' ? tenant1 : tenant2),
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const claim1 = await service.create(
      { workspaceId: 'ws-1', actorDid: 'did:owner1', role: 'owner' },
      { statusPageId: 'page-common', hostname: 'status.corp1.com' },
    );

    const claim2 = await service.create(
      { workspaceId: 'ws-2', actorDid: 'did:owner2', role: 'owner' },
      { statusPageId: 'page-common', hostname: 'status.corp2.com' },
    );

    expect(claim1.workspaceId).toBe('ws-1');
    expect(claim1.statusPageId).toBe('page-common');
    expect(claim1.hostname).toBe('status.corp1.com');

    expect(claim2.workspaceId).toBe('ws-2');
    expect(claim2.statusPageId).toBe('page-common');
    expect(claim2.hostname).toBe('status.corp2.com');
  });

  it('enforces global canonical hostname uniqueness across all workspaces', async () => {
    const control = controlFixture.db;
    const tenant1 = tenant1Fixture.db;
    const tenant2 = tenant2Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner1');
    await seedWorkspace(control, 'ws-2', 'did:owner2');

    await seedStatusPage(tenant1, 'page-1', 'slug-1');
    await seedStatusPage(tenant2, 'page-2', 'slug-2');

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: (wsId) => (wsId === 'ws-1' ? tenant1 : tenant2),
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    // ws-1 registers status.shared.com
    await service.create(
      { workspaceId: 'ws-1', actorDid: 'did:owner1', role: 'owner' },
      { statusPageId: 'page-1', hostname: 'STATUS.shared.COM.' },
    );

    // ws-2 attempts to register the same canonical hostname
    await expect(
      service.create(
        { workspaceId: 'ws-2', actorDid: 'did:owner2', role: 'owner' },
        { statusPageId: 'page-2', hostname: 'status.shared.com' },
      ),
    ).rejects.toThrow('Hostname is already claimed by another workspace');
  });

  it('enforces maximum one domain per status page and supports idempotent retry', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const provider = createCustomDomainProvider({
      type: 'mock',
      environment: 'test',
    });

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const ownerContext: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim1 = await service.create(ownerContext, {
      statusPageId: 'page-1',
      hostname: 'status1.example.com',
    });
    expect(claim1.id).toBeDefined();

    // Idempotent retry returns existing claim
    const retryClaim = await service.create(ownerContext, {
      statusPageId: 'page-1',
      hostname: 'status1.example.com',
    });
    expect(retryClaim.id).toBe(claim1.id);

    // Attempting a second different domain on the same page is rejected
    await expect(
      service.create(ownerContext, {
        statusPageId: 'page-1',
        hostname: 'status2.example.com',
      }),
    ).rejects.toThrow('This status page already has a custom domain assigned');
  });

  // -------------------------------------------------------------------------
  // 3. Quota and Downgrade Tests
  // -------------------------------------------------------------------------

  it('enforces atomic quota reservation before provider network calls', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');
    await seedStatusPage(tenant, 'page-2', 'slug-2');

    let providerCalls = 0;
    const fakeProvider: CustomDomainProvider = {
      type: 'mock',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => {
        providerCalls++;
        return {
          providerId: `fake-${providerCalls}`,
          hostname: opts.hostname,
          status: 'pending_validation',
          cnameInstruction: {
            type: 'CNAME',
            name: opts.hostname,
            target: 'status.uptime.example.com',
            purpose: 'traffic_routing',
          },
          validationRecords: [],
        };
      },
      getCustomHostname: async () => {
        throw new Error('Not implemented');
      },
      deleteCustomHostname: async () => ({ providerId: 'fake', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 1 }),
      provider: fakeProvider,
      clock: () => testNow,
    });

    const ownerContext: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    await service.create(ownerContext, {
      statusPageId: 'page-1',
      hostname: 'domain1.example.com',
    });
    expect(providerCalls).toBe(1);

    await expect(
      service.create(ownerContext, {
        statusPageId: 'page-2',
        hostname: 'domain2.example.com',
      }),
    ).rejects.toThrow('Custom domain quota exceeded for workspace tier');

    expect(providerCalls).toBe(1);
  });

  it('implements deterministic stable cutoff on plan downgrade without data deletion', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');
    await seedStatusPage(tenant, 'page-2', 'slug-2');

    let dynamicQuota = 2;
    let timeOffset = 0;
    const provider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: `cf-${opts.hostname}`,
        hostname: opts.hostname,
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: opts.hostname,
          target: 'status.ingress.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      getCustomHostname: async () => ({
        providerId: 'cf-test',
        hostname: 'dummy',
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: 'dummy',
          target: 'status.ingress.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      deleteCustomHostname: async () => ({ providerId: 'test', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: dynamicQuota }),
      provider,
      clock: () => testNow + timeOffset,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    timeOffset = 0;
    const claim1 = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status-primary.corp.com',
    });

    timeOffset = 1000;
    await service.create(owner, {
      statusPageId: 'page-2',
      hostname: 'status-secondary.corp.com',
    });

    expect(await service.resolvePublicHost('status-primary.corp.com')).not.toBeNull();
    expect(await service.resolvePublicHost('status-secondary.corp.com')).not.toBeNull();

    // Downgrade quota to 1
    dynamicQuota = 1;

    const list = await service.list(owner);
    expect(list.domains).toHaveLength(2);
    expect(list.domains[0]?.hostname).toBe('status-primary.corp.com');
    expect(list.domains[0]?.isEligible).toBe(true);
    expect(list.domains[1]?.hostname).toBe('status-secondary.corp.com');
    expect(list.domains[1]?.isEligible).toBe(false);

    const primaryResolved = await service.resolvePublicHost('status-primary.corp.com');
    expect(primaryResolved?.claimId).toBe(claim1.id);

    const secondaryResolved = await service.resolvePublicHost('status-secondary.corp.com');
    expect(secondaryResolved).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Removal, Tombstones, and Safety Violations
  // -------------------------------------------------------------------------

  it('rejects removal when provider mode mismatches, provider is disabled, or provider ID is missing', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const mockProvider = createCustomDomainProvider({ type: 'mock', environment: 'test' });
    const cfProvider = createCustomDomainProvider({
      type: 'cloudflare',
      apiToken: 'test',
      zoneId: 'zone-1',
      cnameTarget: 'status.ingress.example.com',
    });
    const disabledProvider = createCustomDomainProvider({ type: 'disabled' });

    const mockService = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: mockProvider,
      clock: () => testNow,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await mockService.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.safetypreserve.com',
    });

    // 1. Provider mode mismatch
    const cfService = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: cfProvider,
      clock: () => testNow,
    });
    await expect(cfService.remove(owner, claim.id)).rejects.toThrow('Provider mode mismatch');

    // 2. Disabled provider
    const disabledService = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: disabledProvider,
      clock: () => testNow,
    });
    await expect(disabledService.remove(owner, claim.id)).rejects.toThrow(
      'Custom domain provider is disabled',
    );
    const rowDisabled = await pgFirst<{
      status: string;
      error_code: string;
      deleted_at: string | null;
    }>(
      control,
      `SELECT status, error_code, deleted_at FROM ${control.table('custom_status_domains')} WHERE id = $1`,
      [claim.id],
    );
    expect(rowDisabled?.status).toBe('delete_failed');
    expect(rowDisabled?.error_code).toBe('provider_disabled');
    expect(rowDisabled?.deleted_at).toBeNull();

    // 3. Pending create without provider ID cannot freely release
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET provider_id = NULL, status = 'pending' WHERE id = $1`,
      [claim.id],
    );
    await expect(mockService.remove(owner, claim.id)).rejects.toThrow(
      'operator reconciliation required before releasing hostname',
    );
    const rowNoId = await pgFirst<{
      status: string;
      error_code: string;
      deleted_at: string | null;
    }>(
      control,
      `SELECT status, error_code, deleted_at FROM ${control.table('custom_status_domains')} WHERE id = $1`,
      [claim.id],
    );
    expect(rowNoId?.status).toBe('delete_failed');
    expect(rowNoId?.error_code).toBe('operator_reconciliation_needed');
    expect(rowNoId?.deleted_at).toBeNull();
  });

  it('rejects refresh and simulate on terminal, deleting, or delete_failed states', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });
    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.tombstone-reject.com',
    });

    for (const testStatus of ['deleting', 'delete_failed', 'deleted']) {
      await pgRun(
        control,
        `UPDATE ${control.table('custom_status_domains')} SET status = $1 WHERE id = $2`,
        [testStatus, claim.id],
      );

      await expect(service.refresh(owner, claim.id)).rejects.toThrow(
        `Cannot refresh custom domain in ${testStatus} state`,
      );
      await expect(service.simulate(owner, claim.id, 'ready')).rejects.toThrow(
        `Cannot simulate custom domain in ${testStatus} state`,
      );
    }
  });

  it('retains retryable tombstone on provider delete failure and frees hostname only upon confirmed cleanup', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner1');
    await seedWorkspace(control, 'ws-2', 'did:owner2');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    let failProviderDelete = true;
    const fakeProvider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: 'cf-ch-del-test',
        hostname: opts.hostname,
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: opts.hostname,
          target: 'status.ingress.example.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      getCustomHostname: async (opts) => ({
        providerId: opts.providerId,
        hostname: 'status.tombstone.com',
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: 'status.tombstone.com',
          target: 'status.ingress.example.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      deleteCustomHostname: async () => {
        if (failProviderDelete) {
          throw new CustomDomainProviderError(
            'provider_error',
            'Cloudflare 500 internal error during delete',
            500,
          );
        }
        return { providerId: 'cf-ch-del-test', deleted: true };
      },
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: fakeProvider,
      clock: () => testNow,
    });

    const owner1: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner1',
      role: 'owner',
    };

    const claim = await service.create(owner1, {
      statusPageId: 'page-1',
      hostname: 'status.tombstone.com',
    });

    await expect(service.remove(owner1, claim.id)).rejects.toThrow(
      'Failed to remove custom hostname from upstream provider',
    );

    const tombstoneRow = await pgFirst<{
      status: string;
      deleted_at: string | null;
      error_code: string | null;
    }>(
      control,
      `SELECT status, deleted_at, error_code FROM ${control.table('custom_status_domains')} WHERE id = $1`,
      [claim.id],
    );

    expect(tombstoneRow?.status).toBe('delete_failed');
    expect(tombstoneRow?.deleted_at).toBeNull();
    expect(tombstoneRow?.error_code).toBe('provider_delete_failed');

    // ws-2 cannot claim status.tombstone.com while unique reservation is held
    await seedStatusPage(tenant, 'page-2', 'slug-2');
    await expect(
      service.create(
        { workspaceId: 'ws-2', actorDid: 'did:owner2', role: 'owner' },
        { statusPageId: 'page-2', hostname: 'status.tombstone.com' },
      ),
    ).rejects.toThrow('Hostname is already claimed by another workspace');

    // Retry removal after provider recovery
    failProviderDelete = false;
    const removedResult = await service.remove(owner1, claim.id);
    expect(removedResult.deleted).toBe(true);

    const clearedRow = await pgFirst<{ status: string; deleted_at: string | null }>(
      control,
      `SELECT status, deleted_at FROM ${control.table('custom_status_domains')} WHERE id = $1`,
      [claim.id],
    );

    expect(clearedRow?.status).toBe('deleted');
    expect(clearedRow?.deleted_at).not.toBeNull();

    // Now ws-2 CAN claim status.tombstone.com
    const ws2Claim = await service.create(
      { workspaceId: 'ws-2', actorDid: 'did:owner2', role: 'owner' },
      { statusPageId: 'page-2', hostname: 'status.tombstone.com' },
    );
    expect(ws2Claim.hostname).toBe('status.tombstone.com');
  });

  // -------------------------------------------------------------------------
  // 5. Durable Mock State in CONTROL
  // -------------------------------------------------------------------------

  it('persists mock state durably in CONTROL across fresh provider instances', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    // Service 1 creates the mock claim
    const service1 = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: createCustomDomainProvider({ type: 'mock', environment: 'test' }),
      clock: () => testNow,
    });

    const claim = await service1.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.durable-mock.com',
    });

    // Advance to active via simulate
    const simulated = await service1.simulate(owner, claim.id, 'ready');
    expect(simulated.status).toBe('active');
    expect(simulated.simulationReady).toBe(true);
    expect(simulated.isEligible).toBe(false); // Mock is never public eligible
    expect(simulated.recheckDueAt).toBe(new Date(testNow + 12 * 60 * 60 * 1000).toISOString());

    // Service 2 has a completely new MockCustomDomainProvider instance with EMPTY in-memory map
    const freshMockProvider = createCustomDomainProvider({ type: 'mock', environment: 'test' });
    const service2 = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: freshMockProvider,
      clock: () => testNow + 1000,
    });

    // Refresh succeeds from CONTROL PostgreSQL state without depending on in-memory providerMap
    const refreshed = await service2.refresh(owner, claim.id);
    expect(refreshed.status).toBe('active');
    expect(refreshed.simulationReady).toBe(true);
    expect(refreshed.isEligible).toBe(false);

    // Simulate works with fresh provider
    const simulatedPending = await service2.simulate(owner, claim.id, 'pending_validation');
    expect(simulatedPending.status).toBe('pending');
    expect(simulatedPending.simulationReady).toBe(false);

    // Remove succeeds with fresh provider
    const removeResult = await service2.remove(owner, claim.id);
    expect(removeResult.deleted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. Concurrency and In-Flight Races
  // -------------------------------------------------------------------------

  it('handles in-flight create vs remove by preserving provider_id in tombstone for cleanup', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    let triggerConcurrentRemove: (() => Promise<void>) | null = null;
    const fakeProvider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => {
        if (triggerConcurrentRemove) {
          await triggerConcurrentRemove();
        }
        return {
          providerId: 'cf-late-created-id',
          hostname: opts.hostname,
          status: 'ready',
          cnameInstruction: {
            type: 'CNAME',
            name: opts.hostname,
            target: 'status.ingress.com',
            purpose: 'traffic_routing',
          },
          validationRecords: [],
        };
      },
      getCustomHostname: async () => {
        throw new Error('Not implemented');
      },
      deleteCustomHostname: async () => ({ providerId: 'cf-late-created-id', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: fakeProvider,
      clock: () => testNow,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    triggerConcurrentRemove = async () => {
      await pgRun(
        control,
        `UPDATE ${control.table('custom_status_domains')} SET status = 'deleting', revision = revision + 1 WHERE hostname = $1`,
        ['status.inflight.com'],
      );
    };

    await expect(
      service.create(owner, {
        statusPageId: 'page-1',
        hostname: 'status.inflight.com',
      }),
    ).rejects.toThrow('Custom domain claim was modified concurrently during creation');

    const tombstoneRow = await pgFirst<{ status: string; provider_id: string }>(
      control,
      `SELECT status, provider_id FROM ${control.table('custom_status_domains')} WHERE hostname = $1`,
      ['status.inflight.com'],
    );

    expect(tombstoneRow?.status).toBe('deleting');
    expect(tombstoneRow?.provider_id).toBe('cf-late-created-id');
  });

  it('does not write audit events when CAS concurrency is lost', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const baseProvider = createCustomDomainProvider({ type: 'mock', environment: 'test' });
    let revisionBumped = false;
    const provider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: (options) => baseProvider.createCustomHostname(options),
      getCustomHostname: async (options) => {
        const details = await baseProvider.getCustomHostname(options);
        if (!revisionBumped) {
          revisionBumped = true;
          await pgRun(
            control,
            `UPDATE ${control.table('custom_status_domains')} SET revision = revision + 10 WHERE hostname = $1`,
            ['status.cas-audit.com'],
          );
        }
        return details;
      },
      deleteCustomHostname: (options) => baseProvider.deleteCustomHostname(options),
      lookupCustomHostname: (options) => baseProvider.lookupCustomHostname(options),
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.cas-audit.com',
    });

    // Refresh fails CAS
    await expect(service.refresh(owner, claim.id)).rejects.toThrow(
      'Custom domain claim was modified concurrently during refresh',
    );

    // Verify workspace_events contains ONLY the initial 'custom_domain.created' event, NO 'custom_domain.refreshed'
    const events = await pgAll<{ event: string }>(
      control,
      `SELECT event FROM ${control.table('workspace_events')} WHERE workspace_id = $1`,
      ['ws-1'],
    );

    expect(events.map((e) => e.event)).toEqual(['custom_domain.created']);
  });

  // -------------------------------------------------------------------------
  // 7. Scheduled Reconcile & Clock Skew
  // -------------------------------------------------------------------------

  it('populates 12h deadline and reconciles due domains without role spoofing', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    let currentTime = testNow;
    const provider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: 'cf-reconcile-1',
        hostname: opts.hostname,
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: opts.hostname,
          target: 'status.ingress.example.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      getCustomHostname: async (opts) => ({
        providerId: opts.providerId,
        hostname: 'status.reconciled.com',
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: 'status.reconciled.com',
          target: 'status.ingress.example.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      deleteCustomHostname: async () => ({ providerId: 'cf-reconcile-1', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => currentTime,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.reconciled.com',
    });

    // 12-hour deadline initially set
    expect(claim.recheckDueAt).toBe(new Date(testNow + 12 * 60 * 60 * 1000).toISOString());

    // When time is before deadline, reconcileDue does nothing
    const noDue = await service.reconcileDue();
    expect(noDue.reconciled).toBe(0);

    // Advance clock past 12 hours
    currentTime += 13 * 60 * 60 * 1000;

    // Privileged reconcileDue runs without needing caller actor context
    const reconcileResult = await service.reconcileDue({ limit: 10 });
    expect(reconcileResult.reconciled).toBe(1);
    expect(reconcileResult.errors).toBe(0);

    const updatedRow = await pgFirst<{ recheck_due_at: string; verified_at: string }>(
      control,
      `SELECT recheck_due_at, verified_at FROM ${control.table('custom_status_domains')} WHERE id = $1`,
      [claim.id],
    );

    expect(updatedRow?.recheck_due_at).toBe(
      new Date(currentTime + 12 * 60 * 60 * 1000).toISOString(),
    );
    expect(updatedRow?.verified_at).toBe(new Date(currentTime).toISOString());
  });

  it('rejects public resolution on future timestamps beyond clock skew and invalid freshness bounds', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const provider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: 'cf-skew-1',
        hostname: opts.hostname,
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: opts.hostname,
          target: 'status.ingress.example.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      getCustomHostname: async () => {
        throw new Error('Not implemented');
      },
      deleteCustomHostname: async () => ({ providerId: 'cf-skew-1', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    // Validates finite positive freshness in constructor
    expect(
      () =>
        new CustomStatusDomainService({
          control,
          tenantDbResolver: () => tenant,
          effectiveEntitlementsReader: () => ({ customDomains: 5 }),
          provider,
          maxVerificationFreshnessMs: -100,
        }),
    ).toThrow('maxVerificationFreshnessMs must be a finite positive number');

    expect(
      () =>
        new CustomStatusDomainService({
          control,
          tenantDbResolver: () => tenant,
          effectiveEntitlementsReader: () => ({ customDomains: 5 }),
          provider,
          maxVerificationFreshnessMs: 0,
        }),
    ).toThrow('maxVerificationFreshnessMs must be a finite positive number');

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      clock: () => testNow,
    });

    const claim = await service.create(
      { workspaceId: 'ws-1', actorDid: 'did:owner', role: 'owner' },
      { statusPageId: 'page-1', hostname: 'status.clockskew.com' },
    );

    // 1. Verified timestamp 30s into the future (within 60s tolerance) is accepted
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [new Date(testNow + 30 * 1000).toISOString(), claim.id],
    );
    expect(await service.resolvePublicHost('status.clockskew.com')).not.toBeNull();

    // 2. Verified timestamp 5 minutes into the future (> 60s clock skew) fails closed
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [new Date(testNow + 5 * 60 * 1000).toISOString(), claim.id],
    );
    expect(await service.resolvePublicHost('status.clockskew.com')).toBeNull();

    // 3. Invalid date string fails closed
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      ['invalid-date-string', claim.id],
    );
    expect(await service.resolvePublicHost('status.clockskew.com')).toBeNull();

    // 4. Injected maxVerificationFreshnessMs cutoff
    const shortFreshnessService = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider,
      maxVerificationFreshnessMs: 60 * 1000,
      clock: () => testNow,
    });

    // Fresh within 1 minute
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [new Date(testNow - 30 * 1000).toISOString(), claim.id],
    );
    expect(await shortFreshnessService.resolvePublicHost('status.clockskew.com')).not.toBeNull();

    // Stale beyond 1 minute
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [new Date(testNow - 90 * 1000).toISOString(), claim.id],
    );
    expect(await shortFreshnessService.resolvePublicHost('status.clockskew.com')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8. Pagination and Injected Configuration
  // -------------------------------------------------------------------------

  it('supports paginated list with cursor and nextCursor', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');
    await seedStatusPage(tenant, 'page-2', 'slug-2');
    await seedStatusPage(tenant, 'page-3', 'slug-3');

    let timeOffset = 0;
    const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });
    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 10 }),
      provider,
      clock: () => testNow + timeOffset,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    timeOffset = 100;
    await service.create(owner, { statusPageId: 'page-1', hostname: 'status1.paging.com' });
    timeOffset = 200;
    await service.create(owner, { statusPageId: 'page-2', hostname: 'status2.paging.com' });
    timeOffset = 300;
    await service.create(owner, { statusPageId: 'page-3', hostname: 'status3.paging.com' });

    // Page 1: limit = 2
    const page1 = await service.list(owner, { limit: 2 });
    expect(page1.domains).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    // Page 2: with cursor
    const page2 = await service.list(owner, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.domains).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.domains[0]?.hostname).toBe('status3.paging.com');
  });

  it('respects injected reservedHostnames and configuredRegions', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });

    // Rejects missing resolver/regions
    expect(
      () =>
        new CustomStatusDomainService({
          control,
          tenantDbResolver: () => tenant,
          provider,
        }),
    ).toThrow('requires either effectiveEntitlementsReader or configuredRegions');

    // Injected reserved hostnames
    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      configuredRegions: ['us-east', 'us-west'],
      reservedHostnames: ['reserved.customer.com'],
      provider,
      clock: () => testNow,
    });

    await expect(
      service.create(
        { workspaceId: 'ws-1', actorDid: 'did:owner', role: 'owner' },
        { statusPageId: 'page-1', hostname: 'reserved.customer.com' },
      ),
    ).rejects.toThrow('is reserved for');
  });

  it('rejects public resolution on mock/disabled claims, provider disabled/mismatch, imported workspace, or expired freshness', async () => {
    const control = controlFixture.db;
    const tenant = tenant1Fixture.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const cfProvider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: 'cf-guard-test',
        hostname: opts.hostname,
        status: 'ready',
        cnameInstruction: {
          type: 'CNAME',
          name: opts.hostname,
          target: 'status.fallback.ingress.com',
          purpose: 'traffic_routing',
        },
        validationRecords: [],
      }),
      getCustomHostname: async () => {
        throw new Error('Not implemented');
      },
      deleteCustomHostname: async () => ({ providerId: 'cf-guard-test', deleted: true }),
      lookupCustomHostname: async () => null,
    };
    const disabledProvider = createCustomDomainProvider({ type: 'disabled' });

    let currentTestTime = testNow;
    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: cfProvider,
      clock: () => currentTestTime,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.guards.com',
    });

    // Make it active and verified
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [new Date(currentTestTime).toISOString(), claim.id],
    );

    // Resolves successfully in standard active Cloudflare mode
    const resolved = await service.resolvePublicHost('status.guards.com');
    expect(resolved).not.toBeNull();
    expect(resolved?.claimId).toBe(claim.id);

    // 1. Rejects if claim provider_mode is mock
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET provider_mode = 'mock' WHERE id = $1`,
      [claim.id],
    );
    expect(await service.resolvePublicHost('status.guards.com')).toBeNull();

    // 2. Rejects if claim provider_mode is disabled
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET provider_mode = 'disabled' WHERE id = $1`,
      [claim.id],
    );
    expect(await service.resolvePublicHost('status.guards.com')).toBeNull();

    // Restore provider_mode to cloudflare
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET provider_mode = 'cloudflare' WHERE id = $1`,
      [claim.id],
    );

    // 3. Rejects if service provider is disabled
    const disabledService = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: disabledProvider,
      clock: () => currentTestTime,
    });
    expect(await disabledService.resolvePublicHost('status.guards.com')).toBeNull();

    // 4. Rejects if workspace is imported via trusted postgres_tenant_registry
    await pgRun(
      controlFixture.fixture.adminDb,
      `INSERT INTO ${control.table('postgres_tenant_registry')} (source_database_id, workspace_id, schema_name, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id) DO UPDATE SET source_database_id = EXCLUDED.source_database_id, status = EXCLUDED.status`,
      ['3900c94a-82a0-4422-a5f8-1a56b781cea7', 'ws-1', 'schema_ws_1_imp', 'assigned'],
    );
    expect(await service.resolvePublicHost('status.guards.com')).toBeNull();

    // Also assert create rejects on imported workspace
    await expect(
      service.create(owner, { statusPageId: 'page-1', hostname: 'status.imported-fail.com' }),
    ).rejects.toThrow('Custom domains are not supported on imported workspaces');

    // Clean up registry entry
    await pgRun(
      controlFixture.fixture.adminDb,
      `DELETE FROM ${control.table('postgres_tenant_registry')} WHERE workspace_id = $1`,
      ['ws-1'],
    );
    expect(await service.resolvePublicHost('status.guards.com')).not.toBeNull();

    // Also test tenant_slots fallback (without nonexistent created_at)
    await pgRun(
      controlFixture.fixture.adminDb,
      `INSERT INTO ${control.table('tenant_slots')} (binding_name, workspace_id, database_id, schema_version, status)
       VALUES ($1, $2, $3, 1, 'assigned')`,
      ['DB_IMPORTED_TENANT_STAGING', 'ws-1', '3900c94a-82a0-4422-a5f8-1a56b781cea7'],
    );
    expect(await service.resolvePublicHost('status.guards.com')).toBeNull();

    await pgRun(
      controlFixture.fixture.adminDb,
      `DELETE FROM ${control.table('tenant_slots')} WHERE binding_name = $1`,
      ['DB_IMPORTED_TENANT_STAGING'],
    );
    expect(await service.resolvePublicHost('status.guards.com')).not.toBeNull();

    // 5. Rejects if verification is expired (> 24 hours)
    currentTestTime += 25 * 60 * 60 * 1000;
    expect(await service.resolvePublicHost('status.guards.com')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. Multi-Connection Concurrency Tests (FOR NO KEY UPDATE, Races, Fencing)
  // -------------------------------------------------------------------------

  it('multi-connection quota race serializes through FOR NO KEY UPDATE producing zero audit on loser', async () => {
    const secondConn = await fixture.openConnection();
    try {
      const control1 = controlFixture.db;
      const control2 = secondConn;
      const tenant = tenant1Fixture.db;

      await seedWorkspace(control1, 'ws-race', 'did:owner-race');
      await seedStatusPage(tenant, 'page-race-1', 'slug-race-1');
      await seedStatusPage(tenant, 'page-race-2', 'slug-race-2');

      const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });

      // Quota is exactly 1
      const service1 = new CustomStatusDomainService({
        control: control1,
        tenantDbResolver: () => tenant,
        effectiveEntitlementsReader: () => ({ customDomains: 1 }),
        provider,
        clock: () => testNow,
      });

      const service2 = new CustomStatusDomainService({
        control: control2,
        tenantDbResolver: () => tenant,
        effectiveEntitlementsReader: () => ({ customDomains: 1 }),
        provider,
        clock: () => testNow,
      });

      const owner: CustomStatusDomainActorContext = {
        workspaceId: 'ws-race',
        actorDid: 'did:owner-race',
        role: 'owner',
      };

      // Competing creates over two actual connections concurrently
      const results = await Promise.allSettled([
        service1.create(owner, {
          statusPageId: 'page-race-1',
          hostname: 'race-alpha.example.com',
        }),
        service2.create(owner, {
          statusPageId: 'page-race-2',
          hostname: 'race-beta.example.com',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(CustomStatusDomainError);
      expect(err.code).toBe('quota_exceeded');

      // Verify that ONLY ONE custom domain exists in the database
      const rows = await pgAll<{ hostname: string }>(
        control1,
        `SELECT hostname FROM ${control1.table('custom_status_domains')} WHERE workspace_id = $1 AND deleted_at IS NULL`,
        ['ws-race'],
      );
      expect(rows).toHaveLength(1);

      // Verify zero audit events for the loser: exactly 1 custom_domain.created event!
      const events = await pgAll<{ event: string }>(
        control1,
        `SELECT event FROM ${control1.table('workspace_events')} WHERE workspace_id = $1`,
        ['ws-race'],
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe('custom_domain.created');
    } finally {
      await (secondConn as { close?: () => Promise<void> }).close?.();
    }
  });

  it('multi-connection hostname claim race enforces unique reservation across connections', async () => {
    const secondConn = await fixture.openConnection();
    try {
      const control1 = controlFixture.db;
      const control2 = secondConn;
      const tenant1 = tenant1Fixture.db;
      const tenant2 = tenant2Fixture.db;

      await seedWorkspace(control1, 'ws-host-1', 'did:owner-1');
      await seedWorkspace(control1, 'ws-host-2', 'did:owner-2');
      await seedStatusPage(tenant1, 'page-h-1', 'slug-h-1');
      await seedStatusPage(tenant2, 'page-h-2', 'slug-h-2');

      const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });

      const service1 = new CustomStatusDomainService({
        control: control1,
        tenantDbResolver: () => tenant1,
        effectiveEntitlementsReader: () => ({ customDomains: 5 }),
        provider,
        clock: () => testNow,
      });

      const service2 = new CustomStatusDomainService({
        control: control2,
        tenantDbResolver: () => tenant2,
        effectiveEntitlementsReader: () => ({ customDomains: 5 }),
        provider,
        clock: () => testNow,
      });

      const results = await Promise.allSettled([
        service1.create(
          { workspaceId: 'ws-host-1', actorDid: 'did:owner-1', role: 'owner' },
          { statusPageId: 'page-h-1', hostname: 'contended.example.com' },
        ),
        service2.create(
          { workspaceId: 'ws-host-2', actorDid: 'did:owner-2', role: 'owner' },
          { statusPageId: 'page-h-2', hostname: 'contended.example.com' },
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(CustomStatusDomainError);
      expect(err.code).toMatch(/hostname_already_claimed|hostname_conflict/);

      const claims = await pgAll<{ workspace_id: string }>(
        control1,
        `SELECT workspace_id FROM ${control1.table('custom_status_domains')} WHERE hostname = $1 AND deleted_at IS NULL`,
        ['contended.example.com'],
      );
      expect(claims).toHaveLength(1);
    } finally {
      await (secondConn as { close?: () => Promise<void> }).close?.();
    }
  });

  it('multi-connection deletion fencing rejects concurrent refresh or simulation', async () => {
    const secondConn = await fixture.openConnection();
    try {
      const control1 = controlFixture.db;
      const control2 = secondConn;
      const tenant = tenant1Fixture.db;

      await seedWorkspace(control1, 'ws-fence', 'did:owner-fence');
      await seedStatusPage(tenant, 'page-fence-1', 'slug-fence-1');

      const provider = createCustomDomainProvider({ type: 'mock', environment: 'test' });

      const service1 = new CustomStatusDomainService({
        control: control1,
        tenantDbResolver: () => tenant,
        effectiveEntitlementsReader: () => ({ customDomains: 5 }),
        provider,
        clock: () => testNow,
      });

      const service2 = new CustomStatusDomainService({
        control: control2,
        tenantDbResolver: () => tenant,
        effectiveEntitlementsReader: () => ({ customDomains: 5 }),
        provider,
        clock: () => testNow,
      });

      const owner: CustomStatusDomainActorContext = {
        workspaceId: 'ws-fence',
        actorDid: 'did:owner-fence',
        role: 'owner',
      };

      const claim = await service1.create(owner, {
        statusPageId: 'page-fence-1',
        hostname: 'fence.example.com',
      });

      // Remove starts and completes on conn 1
      const removed = await service1.remove(owner, claim.id);
      expect(removed.deleted).toBe(true);

      // Simultaneous or subsequent refresh/simulate on conn 2 must be rejected
      await expect(service2.refresh(owner, claim.id)).rejects.toThrow(
        /not found|Cannot refresh custom domain in deleted state/,
      );
      await expect(service2.simulate(owner, claim.id, 'ready')).rejects.toThrow(
        /not found|Cannot simulate custom domain in deleted state/,
      );
    } finally {
      await (secondConn as { close?: () => Promise<void> }).close?.();
    }
  });
});
