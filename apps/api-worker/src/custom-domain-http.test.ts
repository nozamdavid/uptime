import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type Database, pgRun } from '@uptime/cloudflare/postgres';
import type {
  RegionId,
  SnapshotFreshness,
  StatusPageReportSnapshot,
  StatusPageReportSnapshotMonitor,
  UptimeDay,
} from '@uptime/contracts';

import {
  createCustomStatusDomainService,
  deriveSnapshotFreshness,
  handleCustomDomainManagement,
  handleCustomDomainPublic,
  reconcileCustomStatusDomains,
  type ApiWorkerCustomDomainEnv,
} from './custom-domain-http.js';
import type { CustomDomainProvider } from './custom-domain-provider.js';
import {
  CustomStatusDomainService,
  type CustomStatusDomainActorContext,
} from './custom-status-domains.js';
import { seedControlUser, seedControlWorkspace } from './testing/control-fixture.js';
import { createRuntimeFixture } from './testing/runtime-fixture.js';

describe('Custom Domain HTTP Layer (PostgreSQL Native)', { timeout: 120_000 }, () => {
  const testNow = 1_700_000_000_000;
  const nowIso = new Date(testNow).toISOString();

  let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;

  beforeAll(async () => {
    fixture = await createRuntimeFixture(['full-hosted', 'full-hosted']);
  }, 180_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  afterEach(async () => {
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('custom_status_domains')}`,
    );
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('workspace_events')}`,
    );
    await fixture.control.fixture.adminDb.query(
      `UPDATE ${fixture.control.db.table('tenant_slots')} SET workspace_id = NULL, status = 'available'`,
    );
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('tenant_slots')} WHERE database_id NOT IN ('source-1', 'source-2')`,
    );
    await fixture.control.fixture.adminDb.query(
      `UPDATE ${fixture.control.db.table('postgres_tenant_registry')} SET workspace_id = NULL, status = 'available'`,
    );
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('postgres_tenant_registry')} WHERE source_database_id NOT IN ('source-1', 'source-2')`,
    );
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('memberships')}`,
    );
    await fixture.control.fixture.adminDb.query(
      `DELETE FROM ${fixture.control.db.table('workspaces')}`,
    );
    await fixture.control.fixture.adminDb.query(`DELETE FROM ${fixture.control.db.table('users')}`);
    await fixture.tenants[0]!.adminDb.query(
      `DELETE FROM ${fixture.tenants[0]!.db.table('status_pages')}`,
    );
    await fixture.tenants[0]!.adminDb.query(
      `DELETE FROM ${fixture.tenants[0]!.db.table('workspace_metadata')}`,
    );
    await fixture.tenants[1]!.adminDb.query(
      `DELETE FROM ${fixture.tenants[1]!.db.table('status_pages')}`,
    );
    await fixture.tenants[1]!.adminDb.query(
      `DELETE FROM ${fixture.tenants[1]!.db.table('workspace_metadata')}`,
    );
  }, 120_000);

  async function seedWorkspace(
    control: Database,
    workspaceId: string,
    ownerDid: string,
    state = 'active',
  ) {
    await seedControlUser(control, ownerDid, `${ownerDid}.handle`, nowIso);
    await seedControlWorkspace(control, {
      workspaceId,
      ownerDid,
      state: state as 'active' | 'suspended' | 'deleting' | 'deleted',
      name: `Workspace ${workspaceId}`,
      timestamp: nowIso,
    });
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

  function buildStatusPageSnapshot(overrides?: {
    pageId?: string;
    publicSlug?: string;
    title?: string;
    generatedAt?: string;
    staleAfterSeconds?: number;
    latestObservationAt?: string | null;
    monitors?: Partial<StatusPageReportSnapshotMonitor>[];
  }): StatusPageReportSnapshot {
    const defaultDay: UptimeDay = {
      date: '2023-11-14',
      uptimePercentage: 100,
      averageResponseMs: 42,
    };

    const defaultMonitor: StatusPageReportSnapshotMonitor = {
      id: 'mon-1',
      name: 'API Gateway',
      url: 'https://internal.service.example/secret-api-key?token=hidden',
      publicSlug: 'api-gateway',
      status: 'up',
      uptimePercentage: 99.95,
      recoveryStatus: null,
      configuredRegionCount: 2,
      affectedRegionIds: [] as RegionId[],
      days: [defaultDay],
    };

    const monitors: StatusPageReportSnapshotMonitor[] = overrides?.monitors
      ? overrides.monitors.map((m, idx) => ({
          ...defaultMonitor,
          id: `mon-${idx + 1}`,
          ...m,
        }))
      : [defaultMonitor];

    const snapshot: StatusPageReportSnapshot = {
      schemaVersion: '1',
      generatedAt: overrides?.generatedAt ?? nowIso,
      latestObservationAt:
        overrides?.latestObservationAt !== undefined ? overrides.latestObservationAt : nowIso,
      staleAfterSeconds: overrides?.staleAfterSeconds ?? 300,
      statusPage: {
        id: overrides?.pageId ?? 'page-1',
        title: overrides?.title ?? 'Acme Corp Status <script>alert(1)</script>',
        publicSlug: overrides?.publicSlug ?? 'pub-slug',
        fontFamily: 'rubik',
        groups: [
          {
            id: 'grp-1',
            title: 'Core Services & APIs',
            width: 'full',
            showBadges: true,
            monitors,
          },
        ],
      },
    };

    return snapshot satisfies StatusPageReportSnapshot;
  }

  // -------------------------------------------------------------------------
  // 1. Factory Tests
  // -------------------------------------------------------------------------

  it('createCustomStatusDomainService handles modes, missing vars, and mock allowlist', () => {
    const control = fixture.control.db;

    // Missing controlDb fails closed
    expect(() =>
      createCustomStatusDomainService({} as unknown as ApiWorkerCustomDomainEnv),
    ).toThrow('controlDb binding is required for CustomStatusDomainService');

    // Disabled mode
    const disabledSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'disabled',
    });
    expect(disabledSvc.providerType).toBe('disabled');
    expect(disabledSvc.isReady).toBe(false);

    // Unknown mode fails closed with setup reason
    const unknownModeSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'invalid_mode',
    });
    expect(unknownModeSvc.providerType).toBe('disabled');
    expect(unknownModeSvc.isReady).toBe(false);
    expect(unknownModeSvc.setupReasons).toContain(
      'Invalid CUSTOM_DOMAIN_MODE configured: "invalid_mode"',
    );

    // Mock mode in production is prohibited and falls back to disabled
    const prodMockSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'production',
    });
    expect(prodMockSvc.providerType).toBe('disabled');
    expect(prodMockSvc.setupReasons).toContain(
      'Mock custom domains are not permitted in this environment',
    );

    // Mock mode without ENVIRONMENT does not default to development and is prohibited
    const emptyEnvMockSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
    });
    expect(emptyEnvMockSvc.providerType).toBe('disabled');
    expect(emptyEnvMockSvc.setupReasons).toContain(
      'Mock custom domains are not permitted in this environment',
    );

    // Mock mode in staging/test is permitted
    const stagingMockSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'staging',
    });
    expect(stagingMockSvc.providerType).toBe('mock');
    expect(stagingMockSvc.isReady).toBe(true);

    // Cloudflare mode with missing secrets falls back to disabled with setup reasons
    const missingCfSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'cloudflare',
      ENVIRONMENT: 'production',
    });
    expect(missingCfSvc.providerType).toBe('disabled');
    expect(missingCfSvc.setupReasons).toContain('Missing CUSTOM_DOMAIN_CNAME_TARGET');
    expect(missingCfSvc.setupReasons).toContain('Missing CLOUDFLARE_SAAS_ZONE_ID');
    expect(missingCfSvc.setupReasons).toContain('Missing CLOUDFLARE_SAAS_API_TOKEN');

    // Cloudflare mode with all required secrets
    const readyCfSvc = createCustomStatusDomainService({
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'cloudflare',
      CUSTOM_DOMAIN_CNAME_TARGET: 'status.ingress.example.com',
      CLOUDFLARE_SAAS_ZONE_ID: 'zone-123',
      CLOUDFLARE_SAAS_API_TOKEN: 'token-abc',
      ENVIRONMENT: 'production',
    });
    expect(readyCfSvc.providerType).toBe('cloudflare');
    expect(readyCfSvc.isReady).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Freshness Derivation Unit Tests
  // -------------------------------------------------------------------------

  it('deriveSnapshotFreshness correctly derives fresh, stale, and unknown states', () => {
    const base: Pick<
      SnapshotFreshness,
      'generatedAt' | 'staleAfterSeconds' | 'latestObservationAt'
    > = {
      generatedAt: nowIso,
      staleAfterSeconds: 300,
      latestObservationAt: nowIso,
    };

    // Within stale window (0s age) -> fresh
    expect(deriveSnapshotFreshness(base, testNow)).toBe('fresh');

    // Inside 300s window (250s age) -> fresh
    expect(deriveSnapshotFreshness(base, testNow + 250_000)).toBe('fresh');

    // Past 300s window (301s age) -> stale
    expect(deriveSnapshotFreshness(base, testNow + 301_000)).toBe('stale');

    // Severely in the future (> 60s clock skew) -> stale
    expect(deriveSnapshotFreshness(base, testNow - 65_000)).toBe('stale');

    // Missing generatedAt -> unknown
    expect(
      deriveSnapshotFreshness({ ...base, generatedAt: '' as unknown as string }, testNow),
    ).toBe('unknown');

    // Unparseable generatedAt -> unknown
    expect(deriveSnapshotFreshness({ ...base, generatedAt: 'not-a-valid-date' }, testNow)).toBe(
      'unknown',
    );

    // Invalid staleAfterSeconds <= 0 -> unknown
    expect(deriveSnapshotFreshness({ ...base, staleAfterSeconds: 0 }, testNow)).toBe('unknown');
    expect(deriveSnapshotFreshness({ ...base, staleAfterSeconds: -10 }, testNow)).toBe('unknown');

    // Invalid latestObservationAt date -> unknown
    expect(deriveSnapshotFreshness({ ...base, latestObservationAt: 'invalid-date' }, testNow)).toBe(
      'unknown',
    );
  });

  // -------------------------------------------------------------------------
  // 3. Management Handler Tests
  // -------------------------------------------------------------------------

  it('handles GET /api/workspace/custom-domains/setup endpoint', async () => {
    const control = fixture.control.db;

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'staging',
      CUSTOM_DOMAIN_CNAME_TARGET: 'status.ingress.mock.com',
    };

    const actor: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const request = new Request('https://api.internal/api/workspace/custom-domains/setup', {
      method: 'GET',
    });

    const response = await handleCustomDomainManagement(request, env, actor);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mode).toBe('mock');
    expect(body.ready).toBe(true);
    expect(body.simulation).toBe(true);
    expect(body.cnameTarget).toBe('status.ingress.mock.com');
  });

  it('resolves domain pages only from the selected workspace tenant and verifies its identity', async () => {
    const control = fixture.control.db;
    const tenant1 = fixture.tenants[0]!.db;
    const tenant2 = fixture.tenants[1]!.db;

    await fixture.assign(0, 'ws-1', 'did:owner');
    await fixture.assign(1, 'ws-2', 'did:owner2');

    await seedStatusPage(tenant1, 'selected-page', 'selected-slug');
    await seedStatusPage(tenant2, 'foreign-page', 'foreign-slug');

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      catalog: fixture.catalog,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'test',
    };

    const service = createCustomStatusDomainService(env, {
      effectiveEntitlementsReader: () => ({ customDomains: 3 }),
      clock: () => testNow,
    });
    const actor = { workspaceId: 'ws-1', actorDid: 'did:owner', role: 'owner' as const };
    await expect(
      service.create(actor, {
        statusPageId: 'selected-page',
        hostname: 'selected.example.com',
      }),
    ).resolves.toMatchObject({ statusPageId: 'selected-page' });
    await expect(
      service.create(actor, {
        statusPageId: 'foreign-page',
        hostname: 'foreign.example.com',
      }),
    ).rejects.toMatchObject({ code: 'status_page_not_found' });
    await fixture.tenants[0]!.db.query(
      `UPDATE ${fixture.tenants[0]!.db.table('workspace_metadata')} SET workspace_id='another-workspace'`,
    );
    await expect(
      service.create(actor, {
        statusPageId: 'selected-page',
        hostname: 'mismatch.example.com',
      }),
    ).rejects.toThrow('PostgreSQL tenant metadata identity mismatch');
  });

  it('handles custom-domains CRUD and simulation lifecycle via management handler', async () => {
    const control = fixture.control.db;
    const tenant = fixture.tenants[0]!.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'slug-1');

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'test',
    };

    const actor: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    let leaseCalled = false;
    const withWriteLease = async (wsId: string, run: () => Promise<Response>) => {
      leaseCalled = true;
      expect(wsId).toBe('ws-1');
      return run();
    };

    const options = {
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      clock: () => testNow,
    };
    const service = createCustomStatusDomainService(env, options);

    // 1. Initial list is empty
    const listReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'GET',
    });
    const listRes = await handleCustomDomainManagement(listReq, env, actor, { service });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { domains: unknown[]; mode: string; ready: boolean };
    expect(listBody.domains).toHaveLength(0);
    expect(listBody.mode).toBe('mock');
    expect(listBody.ready).toBe(true);

    // 2. Reject client-injected role/workspaceId in POST
    const spoofReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statusPageId: 'page-1',
        hostname: 'status.app.com',
        workspaceId: 'ws-other',
      }),
    });
    const spoofRes = await handleCustomDomainManagement(spoofReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(spoofRes.status).toBe(400);

    // 3. Reject unknown body keys in POST
    const unknownFieldReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statusPageId: 'page-1',
        hostname: 'status.app.com',
        unexpectedField: 123,
      }),
    });
    const unknownFieldRes = await handleCustomDomainManagement(unknownFieldReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(unknownFieldRes.status).toBe(400);

    // 4. Create domain
    leaseCalled = false;
    const createReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statusPageId: 'page-1',
        hostname: 'status.app.com',
      }),
    });
    const createRes = await handleCustomDomainManagement(createReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(createRes.status).toBe(201);
    expect(leaseCalled).toBe(true);
    const createdDomain = (await createRes.json()) as {
      id: string;
      status: string;
      hostname: string;
    };
    expect(createdDomain.hostname).toBe('status.app.com');
    expect(createdDomain.status).toBe('pending');

    // 5. Simulate status to active using 'targetStatus'
    leaseCalled = false;
    const simReq1 = new Request(
      `https://api.internal/api/workspace/custom-domains/${createdDomain.id}/simulate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetStatus: 'ready' }),
      },
    );
    const simRes1 = await handleCustomDomainManagement(simReq1, env, actor, {
      service,
      withWriteLease,
    });
    expect(simRes1.status).toBe(200);
    expect(leaseCalled).toBe(true);
    const sim1Body = (await simRes1.json()) as { status: string; simulationReady: boolean };
    expect(sim1Body.status).toBe('active');
    expect(sim1Body.simulationReady).toBe(true);

    // 6. Simulate status using alternative 'status: pending'
    const simReq2 = new Request(
      `https://api.internal/api/workspace/custom-domains/${createdDomain.id}/simulate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      },
    );
    const simRes2 = await handleCustomDomainManagement(simReq2, env, actor, {
      service,
      withWriteLease,
    });
    expect(simRes2.status).toBe(200);
    const sim2Body = (await simRes2.json()) as { status: string };
    expect(sim2Body.status).toBe('pending');

    // 7. Refresh domain
    leaseCalled = false;
    const refreshReq = new Request(
      `https://api.internal/api/workspace/custom-domains/${createdDomain.id}/refresh`,
      { method: 'POST' },
    );
    const refreshRes = await handleCustomDomainManagement(refreshReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(refreshRes.status).toBe(200);
    expect(leaseCalled).toBe(true);

    // 8. Delete domain
    leaseCalled = false;
    const delReq = new Request(
      `https://api.internal/api/workspace/custom-domains/${createdDomain.id}`,
      { method: 'DELETE' },
    );
    const delRes = await handleCustomDomainManagement(delReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(delRes.status).toBe(200);
    expect(leaseCalled).toBe(true);
    const delBody = (await delRes.json()) as { id: string; deleted: boolean };
    expect(delBody.deleted).toBe(true);

    // 9. Malformed percent-encoding in domain route returns 400, not 500
    const malformedReq = new Request(
      'https://api.internal/api/workspace/custom-domains/%ZZ/refresh',
      { method: 'POST' },
    );
    const malformedRes = await handleCustomDomainManagement(malformedReq, env, actor, {
      service,
      withWriteLease,
    });
    expect(malformedRes.status).toBe(400);
    const malformedBody = (await malformedRes.json()) as { error: { code: string } };
    expect(malformedBody.error.code).toBe('invalid_parameter');
  });

  it('rejects simulation in production environment', async () => {
    const control = fixture.control.db;
    await seedWorkspace(control, 'ws-1', 'did:owner');

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'production',
    };

    const actor: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const simReq = new Request(
      'https://api.internal/api/workspace/custom-domains/csd_123/simulate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetStatus: 'ready' }),
      },
    );

    const res = await handleCustomDomainManagement(simReq, env, actor);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('bounds stream reading to 16KiB and rejects oversized or malformed bodies', async () => {
    const control = fixture.control.db;
    const tenant = fixture.tenants[0]!.db;
    await seedWorkspace(control, 'ws-1', 'did:owner');

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'mock',
      ENVIRONMENT: 'test',
    };
    const actor: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };
    const service = createCustomStatusDomainService(env, {
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
    });

    // 1. Oversized body (> 16KiB)
    const largeString = 'a'.repeat(20_000);
    const largeReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statusPageId: 'p1', hostname: largeString }),
    });
    const largeRes = await handleCustomDomainManagement(largeReq, env, actor, { service });
    expect(largeRes.status).toBe(413);

    // 2. Malformed JSON
    const malformedJsonReq = new Request('https://api.internal/api/workspace/custom-domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"invalid": json',
    });
    const malformedJsonRes = await handleCustomDomainManagement(malformedJsonReq, env, actor, {
      service,
    });
    expect(malformedJsonRes.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 4. Public Handler Tests
  // -------------------------------------------------------------------------

  it('handles public status page requests with actual contract fields, freshness derivation, and safe allowlist', async () => {
    const control = fixture.control.db;
    const tenant = fixture.tenants[0]!.db;

    await seedWorkspace(control, 'ws-1', 'did:owner');
    await seedStatusPage(tenant, 'page-1', 'pub-slug');

    const fakeCfProvider: CustomDomainProvider = {
      type: 'cloudflare',
      capabilities: { purgeCacheByHostname: false },
      createCustomHostname: async (opts) => ({
        providerId: 'cf-public-1',
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
      deleteCustomHostname: async () => ({ providerId: 'cf-public-1', deleted: true }),
      lookupCustomHostname: async () => null,
    };

    const service = new CustomStatusDomainService({
      control,
      tenantDbResolver: () => tenant,
      effectiveEntitlementsReader: () => ({ customDomains: 5 }),
      provider: fakeCfProvider,
      clock: () => testNow,
    });

    const owner: CustomStatusDomainActorContext = {
      workspaceId: 'ws-1',
      actorDid: 'did:owner',
      role: 'owner',
    };

    const claim = await service.create(owner, {
      statusPageId: 'page-1',
      hostname: 'status.customer.io',
    });

    // Mark domain active and verified
    await pgRun(
      control,
      `UPDATE ${control.table('custom_status_domains')} SET status = 'active', verified_at = $1 WHERE id = $2`,
      [nowIso, claim.id],
    );

    let sampleSnapshot: StatusPageReportSnapshot = buildStatusPageSnapshot({
      monitors: [
        {
          id: 'mon-1',
          name: 'API Gateway',
          status: 'up',
          uptimePercentage: 99.95,
          recoveryStatus: null,
        },
        {
          id: 'mon-2',
          name: 'Database Cluster',
          status: 'down',
          uptimePercentage: 88.0,
          recoveryStatus: null,
        },
        {
          id: 'mon-3',
          name: 'Background Worker',
          status: 'down',
          uptimePercentage: 95.0,
          recoveryStatus: 'recovering',
        },
        {
          id: 'mon-4',
          name: 'Cache Node',
          status: 'unknown',
          uptimePercentage: null,
          recoveryStatus: null,
        },
      ],
    });

    const loadSnapshot = async (target: {
      workspaceId: string;
      statusPageId: string;
      publicSlug: string;
    }) => {
      expect(target.workspaceId).toBe('ws-1');
      expect(target.statusPageId).toBe('page-1');
      return sampleSnapshot;
    };

    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'cloudflare',
      ENVIRONMENT: 'production',
    };

    // 1. HTML request via /api/public/custom-status/:hostname
    const htmlReq = new Request(
      'https://api.internal/api/public/custom-status/status.customer.io',
      { method: 'GET' },
    );
    const htmlRes = await handleCustomDomainPublic(htmlReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    expect(htmlRes.headers.get('cache-control')).toBe('no-store');
    expect(htmlRes.headers.get('content-security-policy')).toContain("default-src 'none'");

    const html = await htmlRes.text();
    // Escaped title and group
    expect(html).toContain('Acme Corp Status &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Core Services &amp; APIs');
    // Monitor names
    expect(html).toContain('API Gateway');
    expect(html).toContain('Database Cluster');
    expect(html).toContain('Background Worker');
    // Operational, Downtime, Recovering statuses rendered
    expect(html).toContain('Operational');
    expect(html).toContain('Downtime');
    expect(html).toContain('Recovering');
    expect(html).toContain('Uptime: 99.95%');
    // Strictly NO fabricated latency
    expect(html).not.toContain('42ms');
    expect(html).not.toContain('latency');

    // 2. HEAD request returns headers without body
    const headReq = new Request(
      'https://api.internal/api/public/custom-status/status.customer.io',
      { method: 'HEAD' },
    );
    const headRes = await handleCustomDomainPublic(headReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('text/html');
    const headBody = await headRes.text();
    expect(headBody).toBe('');

    // 3. JSON snapshot request via /api/public/custom-status/:hostname/snapshot
    const jsonReq = new Request(
      'https://api.internal/api/public/custom-status/status.customer.io/snapshot',
      { method: 'GET' },
    );
    const jsonRes = await handleCustomDomainPublic(jsonReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toContain('application/json');
    const snapshotData = (await jsonRes.json()) as {
      statusPage: {
        title: string;
        fontFamily: string;
        groups: Array<{ monitors: Array<Record<string, unknown>> }>;
      };
      freshness: string;
      generatedAt: string;
    };
    expect(snapshotData.statusPage.title).toBe('Acme Corp Status <script>alert(1)</script>');
    expect(snapshotData.statusPage.fontFamily).toBe('rubik');
    expect(snapshotData.freshness).toBe('fresh');

    // Allowlist check: ensure url and secrets are NOT exposed
    const mon1 = snapshotData.statusPage.groups[0]?.monitors[0];
    expect(mon1?.status).toBe('up');
    expect(mon1?.uptimePercentage).toBe(99.95);
    expect(mon1?.url).toBeUndefined();

    // 4. Stale snapshot forces displayed monitor state to 'unknown' with historical uptime labelled
    sampleSnapshot = buildStatusPageSnapshot({
      generatedAt: new Date(testNow - 600_000).toISOString(), // 600s old
      staleAfterSeconds: 300, // stale after 300s
      monitors: [
        {
          id: 'mon-1',
          name: 'API Gateway',
          status: 'up',
          uptimePercentage: 99.95,
          recoveryStatus: null,
        },
      ],
    });

    const staleHtmlReq = new Request(
      'https://api.internal/api/public/custom-status/status.customer.io',
      { method: 'GET' },
    );
    const staleHtmlRes = await handleCustomDomainPublic(staleHtmlReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(staleHtmlRes.status).toBe(200);
    const staleHtml = await staleHtmlRes.text();
    // Stale banner displayed
    expect(staleHtml).toContain('Status data is unverified or outdated');
    // Displayed monitor status forced to Unknown instead of Operational
    expect(staleHtml).toContain('Unknown');
    expect(staleHtml).not.toContain('Operational');
    // Historical uptime clearly labelled
    expect(staleHtml).toContain('Historical Uptime: 99.95%');

    // 5. Invalid date timestamp snapshot also forces unknown
    sampleSnapshot = buildStatusPageSnapshot({
      generatedAt: 'invalid-date-string',
      staleAfterSeconds: 300,
      monitors: [
        {
          id: 'mon-1',
          name: 'API Gateway',
          status: 'up',
          uptimePercentage: 99.95,
        },
      ],
    });

    const invalidDateRes = await handleCustomDomainPublic(staleHtmlReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(invalidDateRes.status).toBe(200);
    const invalidDateHtml = await invalidDateRes.text();
    expect(invalidDateHtml).toContain('Status data is unverified or outdated');
    expect(invalidDateHtml).toContain('Unknown');
    expect(invalidDateHtml).not.toContain('Operational');

    // 6. Mismatched statusPage.id or publicSlug returns 404 to avoid serving wrong cached page
    sampleSnapshot = buildStatusPageSnapshot({
      pageId: 'wrong-page-id',
      publicSlug: 'pub-slug',
    });
    const mismatchedIdRes = await handleCustomDomainPublic(htmlReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(mismatchedIdRes.status).toBe(404);

    sampleSnapshot = buildStatusPageSnapshot({
      pageId: 'page-1',
      publicSlug: 'wrong-slug',
    });
    const mismatchedSlugRes = await handleCustomDomainPublic(htmlReq, env, loadSnapshot, {
      service,
      clock: () => testNow,
    });
    expect(mismatchedSlugRes.status).toBe(404);

    // Reset sampleSnapshot to valid
    sampleSnapshot = buildStatusPageSnapshot();

    // 7. Exact public hook ONLY matches /api/public/custom-status/ prefix; root '/' on main API worker returns 404
    const directRootReq = new Request('https://api.internal/', { method: 'GET' });
    const directRootRes = await handleCustomDomainPublic(directRootReq, env, loadSnapshot, {
      service,
    });
    expect(directRootRes.status).toBe(404);

    const directStatusJsonReq = new Request('https://api.internal/status.json', { method: 'GET' });
    const directStatusJsonRes = await handleCustomDomainPublic(
      directStatusJsonReq,
      env,
      loadSnapshot,
      {
        service,
      },
    );
    expect(directStatusJsonRes.status).toBe(404);

    // 8. Unknown hostname returns 404
    const unknownReq = new Request(
      'https://api.internal/api/public/custom-status/unknown.domain.com',
      { method: 'GET' },
    );
    const unknownRes = await handleCustomDomainPublic(unknownReq, env, loadSnapshot, { service });
    expect(unknownRes.status).toBe(404);

    // 9. Prohibited methods return 405
    const postReq = new Request(
      'https://api.internal/api/public/custom-status/status.customer.io',
      { method: 'POST' },
    );
    const postRes = await handleCustomDomainPublic(postReq, env, loadSnapshot, { service });
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get('allow')).toBe('GET, HEAD');

    // 10. Malformed percent-encoding in hostname returns 400
    const malformedHostReq = new Request('https://api.internal/api/public/custom-status/%ZZ', {
      method: 'GET',
    });
    const malformedHostRes = await handleCustomDomainPublic(malformedHostReq, env, loadSnapshot, {
      service,
    });
    expect(malformedHostRes.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 5. Scheduled Reconciliation
  // -------------------------------------------------------------------------

  it('reconcileCustomStatusDomains reconciles due domains', async () => {
    const control = fixture.control.db;
    const env: ApiWorkerCustomDomainEnv = {
      controlDb: control,
      CUSTOM_DOMAIN_MODE: 'disabled',
    };

    const res = await reconcileCustomStatusDomains(env, { limit: 5 });
    expect(res).toEqual({ reconciled: 0, errors: 0 });
  });
});
