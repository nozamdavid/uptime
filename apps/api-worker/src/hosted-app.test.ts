import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  hashPassword,
  hashSessionToken,
  purgeWorkspaceData,
  productionImportedDatabaseId,
  stagingImportedDatabaseId,
  defaultProductCatalog,
  applyWorkspaceTier,
  type R2Bucket,
  type CloudflareEnv,
} from '@uptime/cloudflare';
import {
  parsePostgresRuntimeCatalog,
  quotePostgresIdentifier,
  type Database,
  type RuntimePostgresProfile,
} from '@uptime/cloudflare/postgres';
import { createRuntimeFixture } from './testing/runtime-fixture.js';
import { seedControlUser, seedControlWorkspace } from './testing/control-fixture.js';

import { consumeBudget, ensureWorkspace, hostedFetch } from './hosted-app.js';
import { recordInterest } from './interest.js';
import worker from './index.js';

let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;
let usedTenants = new Set<number>();
beforeAll(async () => {
  fixture = await createRuntimeFixture([
    'full-hosted',
    'full-hosted',
    'full-hosted',
    'full-hosted',
    'full-hosted',
    'legacy-staging',
    'legacy-production',
  ]);
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

describe('hosted control plane', { timeout: 300_000 }, () => {
  it('wires custom domains in session scope and public host prefixes without taking over the main host root', async () => {
    const context = await createHostedContext();
    context.env.CUSTOM_DOMAIN_MODE = 'mock';
    context.env.WEB_ORIGIN = 'https://app.example.com';
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    expect(
      (await fetchHosted(context, '/api/workspace/custom-domains/setup', owner.cookie)).status,
    ).toBe(200);
    expect((await fetchHosted(context, '/api/workspace/custom-domains', '')).status).toBe(401);
    expect(
      (await fetchHosted(context, '/api/public/custom-status/unknown.example', '')).status,
    ).toBe(404);
    expect((await fetchHosted(context, '/', '')).status).toBe(401);
    const body = {
      method: 'POST',
      body: JSON.stringify({ statusPageId: 'page', hostname: 'status.example.net' }),
    };
    expect(
      (
        await fetchHosted(
          context,
          '/api/workspace/custom-domains',
          owner.cookie,
          { origin: 'https://attacker.example' },
          body,
        )
      ).status,
    ).toBe(403);
    await context.control.query(
      `UPDATE ${context.control.table('workspaces')} SET execution_lease_until=$1 WHERE id=$2`,
      ['2099-01-01T00:00:00.000Z', workspaceId],
    );
    expect(
      (await fetchHosted(context, '/api/workspace/custom-domains', owner.cookie, {}, body)).status,
    ).toBe(409);
  });

  it('runs bounded scheduled billing reconciliation without a dashboard visit', async () => {
    const context = await createHostedContext();
    context.env.BILLING_MODE = 'mock';
    context.env.WEB_ORIGIN = 'https://app.example.com';
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    await fetchHosted(context, '/api/auth/session', owner.cookie);
    const checkout = (await (
      await fetchHosted(
        context,
        '/api/workspace/billing/checkout',
        owner.cookie,
        {},
        { method: 'POST', body: JSON.stringify({ tierId: 'pro', revision: 0 }) },
      )
    ).json()) as { sessionId: string; nonce: string };
    await fetchHosted(
      context,
      '/api/workspace/billing/mock/confirm',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify(checkout) },
    );
    await fetchHosted(
      context,
      '/api/workspace/billing/cancel',
      owner.cookie,
      {},
      { method: 'POST', body: '{}' },
    );
    await context.control.query(
      `UPDATE ${context.control.table('workspace_billing')} SET period_end=0,due_at=0`,
    );
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, context.env, {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(
      (
        await context.control.query(
          `SELECT tier_id,catalog_revision FROM ${context.control.table('workspace_tier_assignments')}`,
        )
      ).rows[0],
    ).toEqual({ tier_id: 'free', catalog_revision: 0 });
    expect(
      (
        await context.control.query(
          `SELECT status FROM ${context.control.table('workspace_billing')}`,
        )
      ).rows[0],
    ).toEqual({
      status: 'canceled',
    });
  });

  it('loads custom-domain snapshots from the existing scoped public report and rejects stale page identity', async () => {
    const context = await createHostedContext();
    context.env.BILLING_MODE = 'mock';
    context.env.WEB_ORIGIN = 'https://app.example.com';
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const session = (await (
      await fetchHosted(context, '/api/auth/session', owner.cookie)
    ).json()) as { workspace: { id: string } };
    const workspaceId = session.workspace.id;
    const checkout = await (
      await fetchHosted(
        context,
        '/api/workspace/billing/checkout',
        owner.cookie,
        {},
        { method: 'POST', body: JSON.stringify({ tierId: 'pro', revision: 0 }) },
      )
    ).json();
    await fetchHosted(
      context,
      '/api/workspace/billing/mock/confirm',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify(checkout) },
    );
    const pageId = '11111111-1111-4111-8111-111111111119';
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('status_pages')}(id,title,public_slug) VALUES($1,$2,$3)`,
      [pageId, 'Services', 'services'],
    );
    Object.assign(context.env, {
      CUSTOM_DOMAIN_MODE: 'cloudflare',
      CUSTOM_DOMAIN_CNAME_TARGET: 'gateway.example.net',
      CLOUDFLARE_SAAS_ZONE_ID: 'fake-zone',
      CLOUDFLARE_SAAS_API_TOKEN: 'fake-test-token',
    });
    const timestamp = new Date().toISOString();
    await context.control.query(
      `INSERT INTO ${context.control.table('custom_status_domains')}(id,workspace_id,status_page_id,hostname,provider_mode,status,verified_at,created_at,updated_at) VALUES('domain',$1,$2,$3,'cloudflare','active',$4,$5,$6)`,
      [workspaceId, pageId, 'status.example.net', timestamp, timestamp, timestamp],
    );
    const snapshot = {
      schemaVersion: '1',
      generatedAt: timestamp,
      latestObservationAt: null,
      staleAfterSeconds: 420,
      statusPage: { id: pageId, publicSlug: 'services', title: 'Services', groups: [] },
    };
    const keys: string[] = [];
    context.env.REPORTS = {
      async get(key: string) {
        keys.push(key);
        return {
          async json() {
            return key.endsWith('/cohort.json') ? { generation: '123' } : snapshot;
          },
        };
      },
    } as unknown as R2Bucket;
    const response = await fetchHosted(
      context,
      '/api/public/custom-status/status.example.net/snapshot',
      '',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ statusPage: { id: pageId, title: 'Services' } });
    expect(
      keys.some(
        (key) =>
          key.includes(`tenants/${workspaceId}/`) && key.endsWith('/status-pages/services.json'),
      ),
    ).toBe(true);
    snapshot.statusPage.id = 'wrong-page';
    expect(
      (await fetchHosted(context, '/api/public/custom-status/status.example.net/snapshot', ''))
        .status,
    ).toBe(503);
  });

  it('runs the durable billing journey with membership/owner and mutation origin protection', async () => {
    const context = await createHostedContext();
    context.env.BILLING_MODE = 'mock';
    context.env.WEB_ORIGIN = 'https://app.example.com';
    context.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const viewer = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'viewer.test',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const action = {
      method: 'POST',
      body: JSON.stringify({
        tierId: 'pro',
        revision: 0,
        customerId: 'cus_attacker',
        priceId: 'price_attacker',
        redirectUrl: 'https://attacker.example/',
      }),
    };
    expect((await fetchHosted(context, '/api/workspace/billing', '')).status).toBe(401);
    expect(
      (
        await fetchHosted(
          context,
          '/api/workspace/billing/checkout',
          owner.cookie,
          { origin: 'https://attacker.example' },
          action,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchHosted(
          context,
          '/api/workspace/billing/checkout',
          owner.cookie,
          { 'sec-fetch-site': 'cross-site' },
          action,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchHosted(context, '/api/workspace/billing', viewer.cookie, {
          'x-uptime-workspace': workspaceId,
        })
      ).status,
    ).toBe(403);
    await context.control.query(
      `INSERT INTO ${context.control.table('memberships')}(workspace_id,did,role,created_at) VALUES($1,$2,$3,$4)`,
      [workspaceId, viewer.did, 'viewer', now()],
    );
    const viewerBilling = await fetchHosted(context, '/api/workspace/billing', viewer.cookie, {
      'x-uptime-workspace': workspaceId,
    });
    expect(viewerBilling.status).toBe(200);
    expect(await viewerBilling.json()).toMatchObject({
      actions: { checkout: false },
      mockSession: null,
    });
    expect(
      (
        await fetchHosted(
          context,
          '/api/workspace/billing/checkout',
          viewer.cookie,
          { 'x-uptime-workspace': workspaceId },
          action,
        )
      ).status,
    ).toBe(403);
    const checkout = await fetchHosted(
      context,
      '/api/workspace/billing/checkout',
      owner.cookie,
      {},
      action,
    );
    expect(checkout.status).toBe(200);
    const dto = (await checkout.json()) as { sessionId: string; nonce: string; url: string };
    expect(dto.url).toMatch(/^https:\/\/app.example.com\/mock-billing\/checkout/);
    expect(
      (await fetchHosted(context, '/api/workspace/billing?billing=success', owner.cookie)).status,
    ).toBe(200);
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer n FROM ${context.control.table('workspace_tier_assignments')} WHERE workspace_id=$1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ n: 0 });
    const confirm = {
      method: 'POST',
      body: JSON.stringify({ sessionId: dto.sessionId, nonce: dto.nonce }),
    };
    expect(
      (
        await fetchHosted(
          context,
          '/api/workspace/billing/mock/confirm',
          owner.cookie,
          { origin: 'https://attacker.example' },
          confirm,
        )
      ).status,
    ).toBe(403);
    const confirmed = await fetchHosted(
      context,
      '/api/workspace/billing/mock/confirm',
      owner.cookie,
      {},
      confirm,
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      simulation: true,
      subscription: { status: 'active', tierId: 'pro' },
    });
    expect(
      (await fetchHosted(context, '/api/workspace/billing/mock/confirm', owner.cookie, {}, confirm))
        .status,
    ).toBe(409);
    const publicPricing = await fetchHosted(context, '/api/plans', '');
    expect(await publicPricing.json()).toMatchObject({
      capabilities: { checkout: true },
      billing: { ready: true, mode: 'mock' },
    });
  });

  it('routes the public webhook ahead of session and origin checks while bounding raw input', async () => {
    const context = await createHostedContext();
    const response = await fetchHosted(
      context,
      '/api/billing/webhook',
      '',
      { origin: 'https://stripe.example' },
      { method: 'POST', body: 'x'.repeat(65537) },
    );
    expect(response.status).toBe(413);
    const unsigned = await fetchHosted(
      context,
      '/api/billing/webhook',
      '',
      {},
      { method: 'POST', body: '{}' },
    );
    expect(unsigned.status).toBe(503);
  });

  it('exposes safe plans and fences catalog configuration with operator authorization, CSRF and revision checks', async () => {
    const context = await createHostedContext();
    const publicPlans = await fetchHosted(context, '/api/plans', '');
    expect(publicPlans.status).toBe(200);
    expect(await publicPlans.json()).toMatchObject({
      revision: 0,
      preview: true,
      billingMode: 'mock',
      plans: [{ id: 'free' }, { id: 'pro' }, { id: 'team' }],
      capabilities: { checkout: false },
    });
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'operator.test',
    );
    const catalog = defaultProductCatalog(['eu-west', 'us-east', 'asia']);
    catalog.revision = 1;
    for (const plan of catalog.plans) plan.revision = 1;
    catalog.stripePriceIds = { pro: 'price_PrivateMapping' };
    const input = {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: 0, reason: 'Draft launch', catalog }),
    };
    expect((await fetchHosted(context, '/api/operator/plans', '', {}, input)).status).toBe(401);
    expect(
      (await fetchHosted(context, '/api/operator/plans', owner.cookie, {}, input)).status,
    ).toBe(403);
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/plans',
          operator.cookie,
          { origin: 'https://attacker.example' },
          input,
        )
      ).status,
    ).toBe(403);
    expect(
      (await fetchHosted(context, '/api/operator/plans', operator.cookie, {}, input)).status,
    ).toBe(200);
    expect(
      (await fetchHosted(context, '/api/operator/plans', operator.cookie, {}, input)).status,
    ).toBe(409);
    const safe = await (await fetchHosted(context, '/api/plans', '')).text();
    expect(safe).not.toContain('price_PrivateMapping');
    expect(
      await (await fetchHosted(context, '/api/operator/plans', operator.cookie)).json(),
    ).toMatchObject({ stripePriceIds: { pro: 'price_PrivateMapping' } });
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('product_catalog_revisions')}`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it('enforces assigned paid quotas through API and preserves resources and public page listings after downgrade', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'operator.test',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const catalog = defaultProductCatalog(['eu-west', 'us-east', 'asia']);
    catalog.revision = 1;
    for (const plan of catalog.plans) plan.revision = 1;
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/plans',
          operator.cookie,
          {},
          {
            method: 'PUT',
            body: JSON.stringify({ expectedRevision: 0, reason: 'Preview', catalog }),
          },
        )
      ).status,
    ).toBe(200);
    const assignment = {
      workspaceId,
      revision: 1,
      configuredRegionIds: ['eu-west', 'us-east', 'asia'] as const,
      actor: 'trusted-billing',
      reason: 'Preview contract',
    };
    await applyWorkspaceTier(context.controlDb, {
      ...assignment,
      tierId: 'pro',
      expectedGeneration: 0,
    });
    const monitorIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const created = await fetchHosted(
        context,
        '/api/monitors',
        owner.cookie,
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: `Monitor ${i}`,
            url: `https://example.com/${i}`,
            regionIds: ['us-east'],
            intervalSeconds: 300,
            timeoutMs: 10000,
          }),
        },
      );
      expect(created.status, await created.clone().text()).toBe(201);
      monitorIds.push(
        ((await created.json()) as { summary: { monitor: { id: string } } }).summary.monitor.id,
      );
    }
    const pages: { id: string; publicSlug: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await fetchHosted(
        context,
        '/api/status-pages',
        owner.cookie,
        {},
        {
          method: 'POST',
          body: JSON.stringify({ title: `Page ${i}`, publicSlug: `page-${i}`, groups: [] }),
        },
      );
      expect(created.status, await created.clone().text()).toBe(201);
      pages.push(
        ((await created.json()) as { statusPage: { id: string; publicSlug: string } }).statusPage,
      );
    }
    expect(
      (
        await fetchHosted(
          context,
          '/api/status-pages',
          owner.cookie,
          {},
          { method: 'POST', body: JSON.stringify({ title: 'Fourth', groups: [] }) },
        )
      ).status,
    ).toBe(409);
    Object.assign(context.env, {
      REPORTS: {
        get: async (key: string) => ({
          json: async () =>
            key.endsWith('cohort.json') ? { generation: '123' } : { statusPages: pages },
        }),
      } as unknown as R2Bucket,
    });
    const listing = `/reports/public/status-pages.json?workspace=${workspaceId}`;
    expect(await (await fetchHosted(context, listing, '')).json()).toMatchObject({
      statusPages: pages,
    });
    await applyWorkspaceTier(context.controlDb, {
      ...assignment,
      tierId: 'free',
      expectedGeneration: 1,
    });
    const effective = await fetchHosted(context, '/api/workspace/entitlements', owner.cookie);
    expect(await effective.json()).toMatchObject({
      tierId: 'free',
      revision: 1,
      overrides: null,
      usage: { monitors: 4, statusPages: 3, seats: 1 },
      downgrade: {
        overLimit: true,
        pausedMonitorCount: 1,
        overLimitResources: ['monitors', 'statusPages'],
      },
    });
    expect(
      (
        await fetchHosted(
          context,
          `/api/monitors/${monitorIds[0]}`,
          owner.cookie,
          {},
          { method: 'PATCH', body: JSON.stringify({ enabled: false }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await context.tenant.query(
          `SELECT count(*)::integer AS count FROM ${context.tenant.table('monitors')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 4,
    });
    expect(
      (
        await context.tenant.query(
          `SELECT count(*)::integer AS count FROM ${context.tenant.table('monitor_regions')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 4,
    });
    expect(await (await fetchHosted(context, listing, '')).json()).toMatchObject({
      statusPages: pages,
    });
    expect(
      (
        await fetchHosted(
          context,
          '/api/status-pages',
          owner.cookie,
          {},
          { method: 'POST', body: JSON.stringify({ title: 'Excess after downgrade', groups: [] }) },
        )
      ).status,
    ).toBe(409);
    const after = await (
      await fetchHosted(context, '/api/workspace/entitlements', owner.cookie)
    ).json();
    expect(after).toMatchObject({ downgrade: { pausedMonitorCount: 0, overLimit: true } });
  });

  it('integrates invitation expiry, renewal and revocation routes', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    await fetchHosted(context, '/api/auth/session', owner.cookie);
    const created = await fetchHosted(
      context,
      '/api/workspace/invitations',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({ did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', role: 'viewer' }),
      },
    );
    expect(created.status).toBe(201);
    const invitation = ((await created.json()) as { invitation: { id: string } }).invitation;
    const listing = await fetchHosted(context, '/api/workspace/members', owner.cookie);
    expect(await listing.json()).toMatchObject({
      invitations: [
        {
          id: invitation.id,
          status: 'pending',
          createdAt: expect.any(String),
          expiresAt: expect.any(String),
        },
      ],
    });
    const renewed = await fetchHosted(
      context,
      `/api/workspace/invitations/${invitation.id}/resend`,
      owner.cookie,
      {},
      { method: 'POST' },
    );
    expect(renewed.status).toBe(200);
    const next = ((await renewed.json()) as { invitation: { id: string } }).invitation;
    expect(next.id).not.toBe(invitation.id);
    expect(
      (
        await fetchHosted(
          context,
          `/api/workspace/invitations/${next.id}`,
          owner.cookie,
          {},
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await context.control.query(
          `SELECT id FROM ${context.control.table('workspace_invitations')}`,
        )
      ).rows,
    ).toEqual([]);
  });
  it('guards operator health and scheduling, and rejects unsafe grants without policy writes', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.test',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'operator.test',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const id = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    expect((await fetchHosted(context, '/api/operator/health', owner.cookie)).status).toBe(403);
    expect(
      (await fetchHosted(context, '/api/operator/cloudflare-usage', owner.cookie)).status,
    ).toBe(403);
    const usage = await fetchHosted(context, '/api/operator/cloudflare-usage', operator.cookie);
    expect(await usage.json()).toMatchObject({ status: 'unknown', isWithinAllowance: null });
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/scheduling',
          owner.cookie,
          {},
          { method: 'POST', body: JSON.stringify({ paused: true, reason: 'maintenance' }) },
        )
      ).status,
    ).toBe(403);
    const limits = { monitors: 201, regions: 1, allowedRegionIds: ['us-east'] };
    expect(
      (
        await fetchHosted(
          context,
          `/api/operator/workspaces/${id}/limits`,
          operator.cookie,
          {},
          { method: 'PATCH', body: JSON.stringify(limits) },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await context.control.query(
          `SELECT * FROM ${context.control.table('workspace_product_limits')}`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await context.tenant.query(
          `SELECT monitor_limit FROM ${context.tenant.table('workspace_metadata')}`,
        )
      ).rows[0],
    ).toEqual({
      monitor_limit: 3,
    });
    const preview = await fetchHosted(
      context,
      `/api/operator/workspaces/${id}/limits/preview`,
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify(limits) },
    );
    expect(await preview.json()).toMatchObject({
      capacity: { safe: false, effectiveCaps: { monitorsPerPeriod: 200 } },
    });
    const pause = await fetchHosted(
      context,
      `/api/operator/workspaces/${id}/scheduling`,
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ paused: true, reason: 'maintenance' }) },
    );
    expect(await pause.json()).toMatchObject({
      scheduling: { paused: true, manual: [{ reason: 'maintenance' }] },
    });
    const health = await fetchHosted(context, '/api/operator/health', operator.cookie);
    expect(await health.json()).toMatchObject({
      dispatch: { deadLetterCount: null },
      workspaces: [{ workspaceId: id, scheduling: { paused: true }, error: null }],
    });
  });
  it('assigns the imported fleet without free metadata, proxies authorized edits, and protects its history', async () => {
    const context = await createHostedContext();
    const imported = await addTenant(
      context,
      'STAGING_IMPORTED_DB',
      stagingImportedDatabaseId,
      'legacy-staging',
    );
    await imported.query(
      `INSERT INTO ${imported.table('monitors')}(id,name,url,interval_seconds,timeout_ms,enabled,next_check_at)
       SELECT '00000000-0000-4000-8000-' || lpad(i::text,12,'0'), 'Imported ' || i,
              'https://example.com',60,20000,1,$1
       FROM generate_series(0,106) AS series(i)`,
      [now()],
    );
    await imported.query(
      `UPDATE ${imported.table('monitors')} SET is_public=1,public_slug='imported' WHERE id=$1`,
      ['00000000-0000-4000-8000-000000000000'],
    );
    await imported.query(
      `INSERT INTO ${imported.table('monitor_regions')}(monitor_id,region_id) VALUES($1,$2)`,
      ['00000000-0000-4000-8000-000000000000', 'us-east'],
    );
    await imported.query(
      `INSERT INTO ${imported.table('status_pages')}(id,title,public_slug) VALUES($1,$2,$3)`,
      ['11111111-1111-4111-8111-111111111114', 'Imported services', 'services'],
    );
    Object.assign(context.env, {
      ENVIRONMENT: 'staging',
      INTEREST_CHECK_ONLY: 'true',
    });
    await context.control.query(
      `INSERT INTO ${context.control.table('tenant_slot_controls')}(binding_name,admission_enabled) VALUES('STAGING_IMPORTED_DB',0)`,
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'import.test',
    );
    await recordInterest(context.controlDb, { did: owner.did, handle: 'import.test' });
    const legacyEnv = {
      ...context.env,
      POSTGRES_SOURCE_DATABASE_ID: stagingImportedDatabaseId,
      ENVIRONMENT: 'staging',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: await hashPassword('test-password-only'),
      SESSION_SECRET: 'l'.repeat(32),
      CREDENTIAL_ENCRYPTION_SECRET: 'original-secret'.repeat(4),
      REGIONS_LIST: 'eu-west,us-east,asia',
      WEB_ORIGIN: 'https://api.example.com',
      OAUTH: {
        fetch: (request: Request) =>
          hostedFetch(request, context.env, {
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      },
    };
    Object.assign(context.env, {
      IMPORTED_API: {
        fetch: (request: Request) =>
          worker.fetch(request, legacyEnv, {
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      },
      IMPORTED_REPORTER: {
        fetch: async () => new Response('report', { status: 200 }),
      },
    });
    const assign = () =>
      fetchHosted(
        context,
        '/api/operator/slots/STAGING_IMPORTED_DB/assignment',
        operator.cookie,
        {},
        { method: 'POST', body: JSON.stringify({ ownerDid: owner.did }) },
      );
    const response = await assign();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const workspaceId = ((await response.json()) as { workspaceId: string }).workspaceId;
    const unsupportedLimits = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 10, regions: 1, allowedRegionIds: ['eu-west'] }),
      },
    );
    expect(unsupportedLimits.status).toBe(409);
    expect(await unsupportedLimits.json()).toMatchObject({ error: { code: 'limits_unsupported' } });
    expect((await assign()).status).toBe(200);
    expect(
      (
        await imported.query(
          `SELECT count(*)::integer AS n FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename='workspace_metadata'`,
          [imported.schema],
        )
      ).rows[0],
    ).toEqual({
      n: 0,
    });
    expect(
      await (await fetchHosted(context, '/api/auth/session', owner.cookie)).json(),
    ).toMatchObject({
      workspace: { kind: 'staging_import' },
      usage: { monitors: 107, statusPages: 1 },
      limits: null,
    });
    const monitors = await fetchHosted(context, '/api/monitors', owner.cookie);
    expect(monitors.status).toBe(200);
    expect(((await monitors.json()) as { monitors: unknown[] }).monitors).toHaveLength(107);
    const keys: string[] = [];
    Object.assign(context.env, {
      REPORTS: {
        get: async (key: string) => {
          keys.push(key);
          return {
            json: async () =>
              key === 'public/cohort.json'
                ? { generation: '123' }
                : {
                    statusPages: [
                      { id: '11111111-1111-4111-8111-111111111114', publicSlug: 'services' },
                    ],
                  },
          };
        },
      } as unknown as R2Bucket,
    });
    const monitorReport = await fetchHosted(
      context,
      `/reports/public/monitors/imported.json?workspace=${workspaceId}`,
      '',
    );
    expect(monitorReport.status).toBe(200);
    expect(await monitorReport.json()).toMatchObject({
      schemaVersion: '1',
      latencyByRange: { '1h': {}, '24h': {}, '7d': {}, '30d': {} },
    });
    const index = await fetchHosted(
      context,
      `/reports/public/status-pages.json?workspace=${workspaceId}`,
      '',
    );
    expect(index.status).toBe(200);
    expect(keys).toEqual(['public/cohort.json', 'public/cohorts/123/status-pages.json']);
    const update = await fetchHosted(
      context,
      '/api/monitors/00000000-0000-4000-8000-000000000000',
      owner.cookie,
      {},
      { method: 'PATCH', body: JSON.stringify({ name: 'Updated imported monitor' }) },
    );
    expect(update.status, JSON.stringify(await update.clone().json())).toBe(200);
    expect(
      (
        await imported.query(
          `SELECT name,interval_seconds,timeout_ms FROM ${imported.table('monitors')} WHERE id=$1`,
          ['00000000-0000-4000-8000-000000000000'],
        )
      ).rows[0],
    ).toEqual({ name: 'Updated imported monitor', interval_seconds: 60, timeout_ms: 20000 });
    expect(
      (await fetchHosted(context, '/api/workspace', owner.cookie, {}, { method: 'DELETE' })).status,
    ).toBe(409);
    expect(
      (await imported.query(`SELECT count(*)::integer AS n FROM ${imported.table('monitors')}`))
        .rows[0],
    ).toEqual({ n: 107 });
    expect(
      (
        await context.control.query(
          `SELECT state FROM ${context.control.table('workspaces')} WHERE id=$1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ state: 'active' });
    await expect(
      purgeWorkspaceData(
        { controlDb: context.controlDb, catalog: context.env.catalog.sources },
        workspaceId,
      ),
    ).rejects.toThrow('cannot be purged');
    const stranger = await authenticatedCookie(
      context.control,
      'did:plc:cccccccccccccccccccccccc',
      'stranger.test',
    );
    expect(
      (
        await fetchHosted(context, '/api/auth/imported-identity', stranger.cookie, {
          'x-uptime-workspace': workspaceId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/slots/STAGING_IMPORTED_DB/admission',
          operator.cookie,
          {},
          { method: 'POST', body: JSON.stringify({ enabled: true }) },
        )
      ).status,
    ).toBe(409);
    await context.control.query(
      `UPDATE ${context.control.table('workspaces')} SET state='suspended' WHERE id=$1`,
      [workspaceId],
    );
    expect(
      (
        await fetchHosted(context, '/api/auth/imported-identity', owner.cookie, {
          'x-uptime-workspace': workspaceId,
        })
      ).status,
    ).toBe(403);
  });

  it('bridges the production legacy fleet to the existing owner without free limits or deletion', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const initialSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await initialSession.json()) as { workspace: { id: string } }).workspace
      .id;

    // Reassign only this disposable workspace to the preserved production profile.
    await context.control.query(
      `DELETE FROM ${context.control.table('postgres_tenant_registry')} WHERE workspace_id=$1`,
      [workspaceId],
    );
    await context.control.query(
      `DELETE FROM ${context.control.table('tenant_slots')} WHERE workspace_id=$1`,
      [workspaceId],
    );
    const imported = await addTenant(
      context,
      'PRODUCTION_IMPORTED_DB',
      productionImportedDatabaseId,
      'legacy-production',
    );
    await context.control.query(
      `UPDATE ${context.control.table('postgres_tenant_registry')} SET workspace_id=$1,status='assigned' WHERE source_database_id=$2`,
      [workspaceId, productionImportedDatabaseId],
    );
    await context.control.query(
      `UPDATE ${context.control.table('tenant_slots')} SET workspace_id=$1,status='assigned' WHERE database_id=$2`,
      [workspaceId, productionImportedDatabaseId],
    );
    await imported.query(
      `INSERT INTO ${imported.table('production_workspace_identity')}(id,workspace_id,database_id) VALUES(1,$1,$2)`,
      [workspaceId, productionImportedDatabaseId],
    );
    await imported.query(
      `INSERT INTO ${imported.table('monitors')}(id,name,url,interval_seconds,timeout_ms,enabled,next_check_at)
       SELECT '00000000-0000-4000-8000-' || lpad(i::text,12,'0'), 'Legacy ' || i,
              'https://legacy.example.com/health',60,20000,1,$1
       FROM generate_series(0,106) AS series(i)`,
      [now()],
    );
    await imported.query(
      `UPDATE ${imported.table('monitors')} SET is_public=1,public_slug='legacy' WHERE id=$1`,
      ['00000000-0000-4000-8000-000000000000'],
    );
    await imported.query(
      `INSERT INTO ${imported.table('monitor_regions')}(monitor_id,region_id) VALUES($1,$2)`,
      ['00000000-0000-4000-8000-000000000000', 'us-east'],
    );
    await imported.query(
      `INSERT INTO ${imported.table('status_pages')}(id,title,public_slug) VALUES($1,$2,$3)`,
      ['11111111-1111-4111-8111-111111111115', 'Production services', 'production'],
    );
    await imported.query(
      `INSERT INTO ${imported.table('notification_services')}(id,name,provider,enabled,config,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        '22222222-2222-4222-8222-222222222222',
        'Legacy SMTP',
        'smtp',
        1,
        JSON.stringify({ host: 'smtp.example.com', username: 'legacy', password: 'secret-value' }),
        now(),
        now(),
      ],
    );

    Object.assign(context.env, {
      ENVIRONMENT: 'production',
      OPERATOR_DIDS: `${owner.did},did:plc:operator1111111111111111111111`,
    });

    const adminDid = 'did:plc:operator1111111111111111111111';
    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did,handle,state,created_at,updated_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [adminDid, 'operator.test', 'active', now(), now(), now()],
    );
    const operator = await authenticatedCookie(context.control, adminDid, 'operator.test');
    const extraMemberDid = 'did:plc:viewer222222222222222222222222';
    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did,handle,state,created_at,updated_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [extraMemberDid, 'viewer.test', 'active', now(), now(), now()],
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('memberships')}(workspace_id,did,role,created_at) VALUES($1,$2,'viewer',$3)`,
      [workspaceId, extraMemberDid, now()],
    );
    const viewer = await authenticatedCookie(context.control, extraMemberDid, 'viewer.test');

    const legacyEnv = {
      ...context.env,
      POSTGRES_SOURCE_DATABASE_ID: productionImportedDatabaseId,
      ENVIRONMENT: 'production',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: await hashPassword('legacy-test-password'),
      SESSION_SECRET: 'l'.repeat(32),
      CREDENTIAL_ENCRYPTION_SECRET: 'legacy-secret'.repeat(4),
      REGIONS_LIST: 'eu-west,us-east,asia,asia-east',
      WEB_ORIGIN: 'https://api.example.com',
      OAUTH: {
        fetch: (request: Request) =>
          hostedFetch(request, context.env, {
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      },
    };
    const reporterFetch = async (request: Request) =>
      Response.json({ reporter: 'legacy', path: new URL(request.url).pathname });
    const reportKeys: string[] = [];
    Object.assign(context.env, {
      IMPORTED_API: {
        fetch: (request: Request) =>
          worker.fetch(request, legacyEnv, {
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      },
      IMPORTED_REPORTER: { fetch: reporterFetch },
      REPORTS: {
        get: async (key: string) => {
          reportKeys.push(key);
          return {
            json: async () =>
              key === 'public/cohort.json'
                ? { generation: '123' }
                : {
                    statusPages: [
                      { id: '11111111-1111-4111-8111-111111111115', publicSlug: 'production' },
                    ],
                  },
          };
        },
      } as unknown as R2Bucket,
    });

    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      workspace: { id: workspaceId, kind: 'legacy_import', state: 'active' },
      isOperator: true,
      limits: null,
      usage: { monitors: 107, statusPages: 1, notificationServices: 1 },
    });
    expect(
      (
        await imported.query(
          `SELECT count(*)::integer AS n FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename='workspace_metadata'`,
          [imported.schema],
        )
      ).rows[0],
    ).toEqual({ n: 0 });

    const monitors = await fetchHosted(context, '/api/monitors', owner.cookie);
    expect(monitors.status).toBe(200);
    expect(((await monitors.json()) as { monitors: unknown[] }).monitors).toHaveLength(107);
    const usage = await fetchHosted(context, '/api/workspace/usage', owner.cookie);
    expect(await usage.json()).toMatchObject({ limits: null, usage: { monitors: 107 } });
    const operatorLimits = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      owner.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 3, regions: 1, allowedRegionIds: ['us-east'] }),
      },
    );
    expect(operatorLimits.status).toBe(409);
    expect(await operatorLimits.json()).toMatchObject({ error: { code: 'limits_unsupported' } });

    const identity = await fetchHosted(context, '/api/auth/imported-identity', owner.cookie, {
      'x-uptime-workspace': workspaceId,
    });
    expect(await identity.json()).toMatchObject({
      importedWorkspaceId: workspaceId,
      role: 'owner',
    });
    const viewerIdentity = await fetchHosted(
      context,
      '/api/auth/imported-identity',
      viewer.cookie,
      {
        'x-uptime-workspace': workspaceId,
      },
    );
    expect(await viewerIdentity.json()).toMatchObject({
      importedWorkspaceId: workspaceId,
      role: 'viewer',
    });
    for (const outsider of [
      await authenticatedCookie(
        context.control,
        'did:plc:outsider3333333333333333333333',
        'outsider.test',
      ),
      operator,
    ]) {
      const denied = await fetchHosted(context, '/api/auth/imported-identity', outsider.cookie, {
        'x-uptime-workspace': workspaceId,
      });
      expect(denied.status).toBe(403);
    }
    const viewerMutation = await fetchHosted(
      context,
      '/api/monitors/00000000-0000-4000-8000-000000000000',
      viewer.cookie,
      { 'x-uptime-workspace': workspaceId },
      { method: 'PATCH', body: JSON.stringify({ name: 'Denied viewer edit' }) },
    );
    expect(viewerMutation.status).toBe(403);

    const report = await fetchHosted(
      context,
      `/reports/public/monitors/legacy.json?workspace=${workspaceId}`,
      '',
    );
    expect(await report.json()).toMatchObject({ schemaVersion: '1', staleAfterSeconds: 60 });
    const statusIndex = await fetchHosted(
      context,
      `/reports/public/status-pages.json?workspace=${workspaceId}`,
      '',
    );
    expect(await statusIndex.json()).toMatchObject({
      statusPages: [{ id: '11111111-1111-4111-8111-111111111115', publicSlug: 'production' }],
    });
    expect(reportKeys).toEqual(['public/cohort.json', 'public/cohorts/123/status-pages.json']);

    const exported = await fetchHosted(context, '/api/workspace/export', owner.cookie);
    const exportBody = await exported.clone().text();
    expect(exported.status).toBe(200);
    expect(exportBody).not.toContain('secret-value');
    expect(await exported.json()).toMatchObject({
      destinations: [{ name: 'Legacy SMTP', provider: 'smtp' }],
    });
    const deletion = await fetchHosted(
      context,
      '/api/workspace',
      owner.cookie,
      {},
      { method: 'DELETE' },
    );
    expect(deletion.status).toBe(409);
    expect(
      (await imported.query(`SELECT count(*)::integer AS n FROM ${imported.table('monitors')}`))
        .rows[0],
    ).toEqual({ n: 107 });
    expect(
      (
        await context.control.query(
          `SELECT owner_did,state FROM ${context.control.table('workspaces')} WHERE id=$1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({
      owner_did: owner.did,
      state: 'active',
    });

    const slots = await fetchHosted(context, '/api/operator/slots', owner.cookie);
    expect(await slots.json()).toMatchObject({
      configuredSlots: 0,
      assignedSlots: 0,
      availableSlots: 0,
      slots: [{ bindingName: 'PRODUCTION_IMPORTED_DB', kind: 'legacy_import', workspaceId }],
    });
  });
  it('recognizes the default operator when no allowlist is configured', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );

    const response = await fetchHosted(context, '/api/auth/identity', operator.cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isOperator: true });
  });

  it('exposes OAuth identity without provisioning a workspace or tenant slot', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });

    const response = await fetchHosted(context, '/api/auth/identity', operator.cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { did: operator.did, handle: 'operator.test' },
      isOperator: true,
    });
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspaces')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 0,
    });
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('tenant_slots')} WHERE workspace_id IS NOT NULL`,
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });

  it('serves operator capacity endpoints without provisioning an operator workspace', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });

    const response = await fetchHosted(context, '/api/operator/slots', operator.cookie);

    expect(response.status).toBe(200);
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspaces')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 0,
    });
  });

  it('denies expired and suspended hosted identities', async () => {
    const context = await createHostedContext();
    const expired = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'expired.test',
    );
    await context.control.query(
      `UPDATE ${context.control.table('atproto_login_sessions')} SET expires_at = $1 WHERE did = $2`,
      ['2020-01-01T00:00:00.000Z', expired.did],
    );
    expect((await fetchHosted(context, '/api/auth/identity', expired.cookie)).status).toBe(401);

    const suspended = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'suspended.test',
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did, handle, state, created_at, updated_at, last_seen_at) VALUES ($1, $2, 'suspended', $3, $4, $5)`,
      [suspended.did, 'suspended.test', now(), now(), now()],
    );
    expect((await fetchHosted(context, '/api/auth/identity', suspended.cookie)).status).toBe(403);
  });

  it('bridges a real hosted OAuth cookie into legacy session and monitor reads', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    const legacyDb = await addTenant(
      context,
      'STAGING_IMPORTED_DB',
      stagingImportedDatabaseId,
      'legacy-staging',
    );
    const legacyId = '11111111-1111-4111-8111-111111111111';
    await seedControlUser(context.control, operator.did, 'operator.test');
    await seedControlWorkspace(context.control, { workspaceId: legacyId, ownerDid: operator.did });
    await legacyDb.query(
      `INSERT INTO ${legacyDb.table('staging_workspace_identity')}(id,workspace_id,database_id) VALUES(1,$1,$2)`,
      [legacyId, stagingImportedDatabaseId],
    );
    await context.control.query(
      `UPDATE ${context.control.table('postgres_tenant_registry')} SET workspace_id=$1,status='assigned' WHERE source_database_id=$2`,
      [legacyId, stagingImportedDatabaseId],
    );
    await context.control.query(
      `UPDATE ${context.control.table('tenant_slots')} SET workspace_id=$1,status='assigned' WHERE database_id=$2`,
      [legacyId, stagingImportedDatabaseId],
    );
    const legacyEnv = {
      ...context.env,
      POSTGRES_SOURCE_DATABASE_ID: stagingImportedDatabaseId,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse battery staple'),
      SESSION_SECRET: 'l'.repeat(32),
      CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
      REGIONS_LIST: '',
      ENVIRONMENT: 'test',
      OAUTH: {
        fetch: (request: Request) =>
          hostedFetch(request, context.env, {
            waitUntil() {},
          } as unknown as ExecutionContext),
      },
    };
    const response = await worker.fetch(
      new Request('https://legacy.example.com/api/auth/session', {
        headers: { cookie: operator.cookie },
      }),
      legacyEnv as Parameters<typeof worker.fetch>[1],
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { did: operator.did, handle: 'operator.test' },
      role: 'owner',
      isOperator: true,
    });
    const monitors = await worker.fetch(
      new Request('https://legacy.example.com/api/monitors', {
        headers: { cookie: operator.cookie },
      }),
      legacyEnv as Parameters<typeof worker.fetch>[1],
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(monitors.status).toBe(200);
    expect(
      (
        await context.control.query(
          `SELECT id FROM ${context.control.table('workspaces')} ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: legacyId }]);
  });

  it('confirms only the signed-in interest record and blocks new product access before release', async () => {
    const context = await createHostedContext();
    Object.assign(context.env, { INTEREST_CHECK_ONLY: 'true' });
    const user = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'interest.test',
    );
    await recordInterest(context.controlDb, { did: user.did, handle: 'interest.test' });
    expect(await (await fetchHosted(context, '/api/interest/session', '')).json()).toEqual({
      signup: null,
    });
    expect(
      await (await fetchHosted(context, '/api/interest/session', user.cookie)).json(),
    ).toMatchObject({ signup: { did: user.did, handle: 'interest.test' } });
    const access = await fetchHosted(context, '/api/auth/session', user.cookie);
    expect(access.status).toBe(403);
    expect(await access.json()).toMatchObject({ error: { code: 'product_not_released' } });
    expect((await fetchHosted(context, '/api/operator/interest', user.cookie)).status).toBe(403);
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspaces')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 0,
    });
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('tenant_slots')} WHERE status='available'`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    const collected = await fetchHosted(context, '/api/operator/interest', operator.cookie);
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      total: 1,
      signups: [{ did: user.did, handle: 'interest.test' }],
    });
  });

  it('lets operators inspect capacity, change its limit, and hold only unused slots', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    await fetchHosted(context, '/api/auth/session', operator.cookie);
    const spare = await addTenant(context, 'TENANT_TWO', 'tenant-two');
    const inventory = await fetchHosted(context, '/api/operator/slots', operator.cookie);
    expect(await inventory.json()).toMatchObject({
      configuredSlots: 2,
      assignedSlots: 1,
      availableSlots: 1,
      heldSlots: 0,
      quarantinedSlots: 0,
    });
    const patch = async (limit: number) =>
      fetchHosted(
        context,
        '/api/operator/slots',
        operator.cookie,
        {},
        { method: 'PATCH', body: JSON.stringify({ maxWorkspaces: limit }) },
      );
    expect((await patch(11)).status).toBe(400);
    expect(await (await patch(10)).json()).toMatchObject({ maxWorkspaces: 10 });
    expect(await (await patch(1)).json()).toMatchObject({ maxWorkspaces: 1 });
    const user = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'new.test',
    );
    expect(
      await (await fetchHosted(context, '/api/auth/session', user.cookie)).json(),
    ).toMatchObject({ workspace: { state: 'waiting_for_capacity' } });
    const hold = async (binding: string, enabled: boolean) =>
      fetchHosted(
        context,
        `/api/operator/slots/${binding}/admission`,
        operator.cookie,
        {},
        { method: 'POST', body: JSON.stringify({ enabled }) },
      );
    expect(await (await hold('TENANT_TWO', false)).json()).toMatchObject({
      availableSlots: 0,
      heldSlots: 1,
    });
    await patch(2);
    expect(
      await (await fetchHosted(context, '/api/auth/session', user.cookie)).json(),
    ).toMatchObject({ workspace: { state: 'waiting_for_capacity' } });
    expect(await (await hold('TENANT_TWO', true)).json()).toMatchObject({
      availableSlots: 1,
      heldSlots: 0,
    });
    expect(
      await (await fetchHosted(context, '/api/auth/session', user.cookie)).json(),
    ).toMatchObject({ workspace: { state: 'active' } });
    expect((await hold('TENANT_TWO', false)).status).toBe(409);
    expect((await hold('TENANT_ONE', false)).status).toBe(409);
    expect((await hold('CONTROL_DB', false)).status).toBe(409);
    expect((await hold('UNBOUND', false)).status).toBe(409);
    expect((await fetchHosted(context, '/api/operator/slots', user.cookie)).status).toBe(403);
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/slots',
          user.cookie,
          {},
          { method: 'PATCH', body: JSON.stringify({ maxWorkspaces: 1 }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspace_events')} WHERE event='slot_admission'`,
        )
      ).rows[0],
    ).toEqual({ count: 2 });
  });

  it('keeps deleted database slots quarantined when the operator tries to reopen them', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    await fetchHosted(context, '/api/auth/session', operator.cookie);
    await context.control.query(
      `UPDATE ${context.control.table('tenant_slots')} SET status='deleting' WHERE binding_name='TENANT_ONE'`,
    );
    const response = await fetchHosted(
      context,
      '/api/operator/slots/TENANT_ONE/admission',
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
    );
    expect(response.status).toBe(409);
    expect(
      (await context.control.query(`SELECT status FROM ${context.control.table('tenant_slots')}`))
        .rows[0],
    ).toEqual({
      status: 'deleting',
    });
  });

  it('lets the operator provision a waiting signup and resume a suspended workspace', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    await fetchHosted(context, '/api/auth/session', operator.cookie);
    const user = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'noz.am',
    );
    const signup = await fetchHosted(context, '/api/auth/session', user.cookie);
    const workspace = ((await signup.json()) as { workspace: { id: string; state: string } })
      .workspace;
    expect(workspace.state).toBe('waiting_for_capacity');
    const operatorWorkspaces = await fetchHosted(
      context,
      '/api/operator/workspaces',
      operator.cookie,
    );
    const listed = (await operatorWorkspaces.json()) as {
      workspaces: { id: string; limits: unknown }[];
    };
    expect(listed.workspaces.find((row) => row.id === workspace.id)?.limits).toBeNull();
    const path = `/api/operator/workspaces/${workspace.id}/state`;
    const activate = {
      method: 'POST',
      body: JSON.stringify({ state: 'active', reason: 'Operator restored' }),
    };
    expect((await fetchHosted(context, path, user.cookie, {}, activate)).status).toBe(403);
    const unprovisionedLimits = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspace.id}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({
          monitors: 5,
          regions: 3,
          allowedRegionIds: ['eu-west', 'us-east', 'asia'],
        }),
      },
    );
    expect(unprovisionedLimits.status).toBe(409);
    expect(await unprovisionedLimits.json()).toMatchObject({
      error: { code: 'workspace_unprovisioned' },
    });
    const noCapacity = await fetchHosted(context, path, operator.cookie, {}, activate);
    expect(noCapacity.status).toBe(409);
    expect(await noCapacity.json()).toMatchObject({ error: { code: 'capacity_unavailable' } });
    const secondTenant = await addTenant(context, 'TENANT_TWO', 'tenant-two');
    await context.control.query(
      `UPDATE ${context.control.table('service_controls')} SET admission_open=0, external_monthly_cost_usd=15 WHERE id=1`,
    );
    const activated = await fetchHosted(context, path, operator.cookie, {}, activate);
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ id: workspace.id, state: 'active' });
    expect(
      (
        await context.control.query(
          `SELECT admission_open FROM ${context.control.table('service_controls')} WHERE id=1`,
        )
      ).rows[0],
    ).toEqual({ admission_open: 0 });
    expect(
      (
        await secondTenant.query(
          `SELECT workspace_id FROM ${secondTenant.table('workspace_metadata')} WHERE id=1`,
        )
      ).rows[0],
    ).toEqual({ workspace_id: workspace.id });
    await fetchHosted(
      context,
      path,
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ state: 'suspended', reason: 'Operator action' }) },
    );
    const suspended = await fetchHosted(context, '/api/auth/session', user.cookie);
    expect(await suspended.json()).toMatchObject({ workspace: { state: 'suspended' } });
    expect((await fetchHosted(context, path, operator.cookie, {}, activate)).status).toBe(200);
    expect(
      await (await fetchHosted(context, '/api/auth/session', user.cookie)).json(),
    ).toMatchObject({ workspace: { state: 'active' } });
  });

  it('lets manual operator activation bypass budget checks while automatic signup stays guarded', async () => {
    const context = await createHostedContext();
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    await fetchHosted(context, '/api/auth/session', operator.cookie);
    const user = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'noz.am',
    );
    const signup = await fetchHosted(context, '/api/auth/session', user.cookie);
    const workspace = ((await signup.json()) as { workspace: { id: string; state: string } })
      .workspace;
    expect(workspace.state).toBe('waiting_for_capacity');
    const path = `/api/operator/workspaces/${workspace.id}/state`;
    const activate = {
      method: 'POST',
      body: JSON.stringify({ state: 'active', reason: 'Operator restored' }),
    };
    const noCapacity = await fetchHosted(context, path, operator.cookie, {}, activate);
    expect(noCapacity.status).toBe(409);
    expect(await noCapacity.json()).toMatchObject({
      error: {
        code: 'capacity_unavailable',
        message: 'Activation needs an available database slot and space under the workspace limit.',
      },
    });
    const secondTenant = await addTenant(context, 'TENANT_TWO', 'tenant-two');
    await context.control.query(
      `UPDATE ${context.control.table('service_controls')} SET admission_open=0 WHERE id=1`,
    );
    const knownUsage = context.env.CURRENT_BUDGET_USAGE_JSON;
    delete context.env.CURRENT_BUDGET_USAGE_JSON;
    const stateOf = async (id: string) =>
      (
        await context.control.query(
          `SELECT state FROM ${context.control.table('workspaces')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
    const assignedTo = async (tenant: Database) =>
      (
        await tenant.query(
          `SELECT workspace_id FROM ${tenant.table('workspace_metadata')} WHERE id=1`,
        )
      ).rows[0];

    // Automatic signup keeps the admission and forecast guards, so another user stays waiting.
    const autoUser = await authenticatedCookie(
      context.control,
      'did:plc:cccccccccccccccccccccccc',
      'auto.test',
    );
    const autoSignup = await fetchHosted(context, '/api/auth/session', autoUser.cookie);
    const autoWorkspace = ((await autoSignup.json()) as { workspace: { id: string } }).workspace;
    expect(await stateOf(autoWorkspace.id)).toEqual({ state: 'waiting_for_capacity' });
    expect(await assignedTo(secondTenant)).toBeUndefined();

    // Unknown forecast and closed admission do not block manual activation.
    const activated = await fetchHosted(context, path, operator.cookie, {}, activate);
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ id: workspace.id, state: 'active' });
    expect(await assignedTo(secondTenant)).toEqual({ workspace_id: workspace.id });

    // A forecast at or above the ceiling does not block it either, and automatic signup still waits.
    const thirdTenant = await addTenant(context, 'TENANT_THREE', 'tenant-three');
    context.env.CURRENT_BUDGET_USAGE_JSON = knownUsage;
    await context.control.query(
      `UPDATE ${context.control.table('service_controls')} SET external_monthly_cost_usd=15 WHERE id=1`,
    );
    await fetchHosted(context, '/api/auth/session', autoUser.cookie);
    expect(await stateOf(autoWorkspace.id)).toEqual({ state: 'waiting_for_capacity' });
    expect(await assignedTo(thirdTenant)).toBeUndefined();
    const overBudget = await fetchHosted(
      context,
      `/api/operator/workspaces/${autoWorkspace.id}/state`,
      operator.cookie,
      {},
      activate,
    );
    expect(overBudget.status).toBe(200);
    expect(await overBudget.json()).toEqual({ id: autoWorkspace.id, state: 'active' });
    expect(await assignedTo(thirdTenant)).toEqual({ workspace_id: autoWorkspace.id });
    expect(
      (
        await context.control.query(
          `SELECT admission_open FROM ${context.control.table('service_controls')} WHERE id=1`,
        )
      ).rows[0],
    ).toEqual({ admission_open: 0 });
  });

  it('serves defaults and applies workspace-scoped operator limits above the original caps', async () => {
    const context = await createHostedContext();
    const secondTenant = await addTenant(context, 'TENANT_TWO', 'tenant-two');
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:limitowner1111111111111111',
      'limits.bsky.social',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const secondOwner = await authenticatedCookie(
      context.control,
      'did:plc:limitowner2222222222222222',
      'second-limits.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const sessionBody = (await session.json()) as {
      workspace: { id: string };
      limits: { monitors: number; regions: number; allowedRegionIds: string[] };
    };
    const workspaceId = sessionBody.workspace.id;
    const secondSession = await fetchHosted(context, '/api/auth/session', secondOwner.cookie);
    const secondWorkspaceId = (
      (await secondSession.json()) as { workspace: { id: string }; limits: { monitors: number } }
    ).workspace.id;
    expect(sessionBody).toMatchObject({
      limits: {
        monitors: 3,
        regions: 3,
        allowedRegionIds: ['eu-west', 'us-east', 'asia'],
      },
    });

    const listing = await fetchHosted(context, '/api/operator/workspaces', operator.cookie);
    expect(listing.status).toBe(200);
    const listingBody = (await listing.json()) as {
      availableRegions: { id: string }[];
      workspaces: { id: string; limits: { monitors: number; allowedRegionIds: string[] } | null }[];
    };
    expect(listingBody.availableRegions.map((region) => region.id)).toHaveLength(9);
    expect(listingBody.workspaces.find((row) => row.id === workspaceId)?.limits).toMatchObject({
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['eu-west', 'us-east', 'asia'],
    });
    expect(
      listingBody.workspaces.find((row) => row.id === secondWorkspaceId)?.limits,
    ).toMatchObject({
      monitors: 3,
      regions: 3,
    });
    expect((await fetchHosted(context, '/api/operator/workspaces', owner.cookie)).status).toBe(403);

    const input = {
      monitors: 5,
      regions: 4,
      allowedRegionIds: ['eu-west', 'us-east', 'asia', 'asia-east'],
    };
    for (const [invalidInput, expectedCode] of [
      [{ monitors: 5, regions: 2, allowedRegionIds: ['eu-west', 'eu-west'] }, 'region_duplicate'],
      [{ monitors: 5, regions: 1, allowedRegionIds: ['mars'] }, 'region_invalid'],
      [{ monitors: 5, regions: 2, allowedRegionIds: ['eu-west'] }, 'region_limit_invalid'],
    ] as const) {
      const rejected = await fetchHosted(
        context,
        `/api/operator/workspaces/${workspaceId}/limits`,
        operator.cookie,
        {},
        { method: 'PATCH', body: JSON.stringify(invalidInput) },
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: expectedCode } });
    }
    const updated = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      { method: 'PATCH', body: JSON.stringify(input) },
    );
    expect(updated.status, JSON.stringify(await updated.clone().json())).toBe(200);
    expect(await updated.json()).toMatchObject({ limits: input });
    expect(
      (
        await context.tenant.query(
          `SELECT monitor_limit,region_limit,allowed_region_ids FROM ${context.tenant.table('workspace_metadata')}`,
        )
      ).rows[0],
    ).toEqual({
      monitor_limit: 5,
      region_limit: 4,
      allowed_region_ids: JSON.stringify(input.allowedRegionIds),
    });
    expect(
      (
        await secondTenant.query(
          `SELECT monitor_limit,region_limit FROM ${secondTenant.table('workspace_metadata')}`,
        )
      ).rows[0],
    ).toEqual({ monitor_limit: 3, region_limit: 3 });

    const currentSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(await currentSession.json()).toMatchObject({ limits: input });
    const unchangedSession = await fetchHosted(context, '/api/auth/session', secondOwner.cookie);
    expect(await unchangedSession.json()).toMatchObject({
      limits: { monitors: 3, regions: 3, allowedRegionIds: ['eu-west', 'us-east', 'asia'] },
    });
    const usage = await fetchHosted(context, '/api/workspace/usage', owner.cookie);
    expect(await usage.json()).toMatchObject({ limits: input });
    const regions = await fetchHosted(context, '/api/regions', owner.cookie);
    expect(
      ((await regions.json()) as { regions: { id: string }[] }).regions
        .map((item) => item.id)
        .sort(),
    ).toEqual([...input.allowedRegionIds].sort());

    for (let index = 0; index < 5; index += 1) {
      const created = await fetchHosted(
        context,
        '/api/monitors',
        owner.cookie,
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: `Extra monitor ${index}`,
            url: `https://service-${index}.example.com/health`,
            regionIds: input.allowedRegionIds,
            intervalSeconds: 300,
            timeoutMs: 10000,
            outageThreshold: 2,
            recoveryThreshold: 1,
          }),
        },
      );
      expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    }
    const capped = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Over limit',
          url: 'https://over-limit.example.com',
          regionIds: ['eu-west'],
          intervalSeconds: 300,
          timeoutMs: 10000,
          outageThreshold: 2,
          recoveryThreshold: 1,
        }),
      },
    );
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ error: { code: 'monitor_limit' } });

    const unavailable = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Unavailable region',
          url: 'https://region.example.com',
          regionIds: ['asia-south'],
          intervalSeconds: 300,
          timeoutMs: 10000,
          outageThreshold: 2,
          recoveryThreshold: 1,
        }),
      },
    );
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'region_unavailable' } });
  });

  it('lets operators and owners repair monitors after a saved region leaves the deployment', async () => {
    const context = await createHostedContext();
    const secondTenant = await addTenant(context, 'TENANT_TWO', 'tenant-two');
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:limitowner1111111111111111',
      'stale-region.bsky.social',
    );
    const secondOwner = await authenticatedCookie(
      context.control,
      'did:plc:limitowner2222222222222222',
      'other-region.bsky.social',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const secondSession = await fetchHosted(context, '/api/auth/session', secondOwner.cookie);
    const secondWorkspaceId = ((await secondSession.json()) as { workspace: { id: string } })
      .workspace.id;
    const initialPolicy = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 3, regions: 2, allowedRegionIds: ['eu-west', 'asia'] }),
      },
    );
    expect(initialPolicy.status).toBe(200);
    const created = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Keep monitoring after region removal',
          url: 'https://stale-region.example.com/health',
          regionIds: ['eu-west', 'asia'],
          intervalSeconds: 300,
          timeoutMs: 10000,
          outageThreshold: 2,
          recoveryThreshold: 1,
        }),
      },
    );
    expect(created.status).toBe(201);
    const monitorId = ((await created.json()) as { summary: { monitor: { id: string } } }).summary
      .monitor.id;

    Object.assign(context.env, { REGIONS_LIST: 'us-east,asia-east' });
    const staleSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(staleSession.status).toBe(200);
    expect(await staleSession.json()).toMatchObject({
      limits: { monitors: 3, regions: 2, allowedRegionIds: ['eu-west', 'asia'] },
    });
    const staleUsage = await fetchHosted(context, '/api/workspace/usage', owner.cookie);
    expect(staleUsage.status).toBe(200);
    expect(await staleUsage.json()).toMatchObject({
      limits: { allowedRegionIds: ['eu-west', 'asia'] },
    });
    const staleRegions = await fetchHosted(context, '/api/regions', owner.cookie);
    expect(staleRegions.status).toBe(200);
    expect(await staleRegions.json()).toEqual({ regions: [] });

    const listing = await fetchHosted(context, '/api/operator/workspaces', operator.cookie);
    expect(listing.status).toBe(200);
    const listingBody = (await listing.json()) as {
      workspaces: { id: string; limits: unknown }[];
    };
    expect(listingBody).toMatchObject({
      workspaces: [{ id: expect.any(String) }, { id: expect.any(String) }],
    });
    expect(
      listingBody.workspaces.find((workspace) => workspace.id === workspaceId)?.limits,
    ).toMatchObject({
      allowedRegionIds: ['eu-west', 'asia'],
    });
    expect(listingBody.workspaces.some((workspace) => workspace.id === secondWorkspaceId)).toBe(
      true,
    );

    const repairedPolicy = { monitors: 3, regions: 1, allowedRegionIds: ['us-east'] };
    const updatedPolicy = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      { method: 'PATCH', body: JSON.stringify(repairedPolicy) },
    );
    expect(updatedPolicy.status, JSON.stringify(await updatedPolicy.clone().json())).toBe(200);
    expect(await updatedPolicy.json()).toMatchObject({ limits: repairedPolicy });
    expect(
      (
        await context.tenant.query(
          `SELECT enabled FROM ${context.tenant.table('monitors')} WHERE id = $1`,
          [monitorId],
        )
      ).rows[0],
    ).toEqual({
      enabled: 1,
    });

    const repairedSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(repairedSession.status).toBe(200);
    expect(await repairedSession.json()).toMatchObject({ limits: repairedPolicy });
    const availableRegions = await fetchHosted(context, '/api/regions', owner.cookie);
    expect(await availableRegions.json()).toMatchObject({
      regions: [{ id: 'us-east' }],
    });
    const monitors = await fetchHosted(context, '/api/monitors', owner.cookie);
    expect(await monitors.json()).toMatchObject({
      monitors: [{ monitor: { id: monitorId, regionIds: ['asia', 'eu-west'] } }],
    });

    const repairedMonitor = await fetchHosted(
      context,
      `/api/monitors/${monitorId}`,
      owner.cookie,
      {},
      { method: 'PATCH', body: JSON.stringify({ regionIds: ['us-east'] }) },
    );
    expect(repairedMonitor.status, JSON.stringify(await repairedMonitor.clone().json())).toBe(200);
    expect(
      (
        await context.tenant.query(
          `SELECT region_id FROM ${context.tenant.table('monitor_regions')} WHERE monitor_id = $1`,
          [monitorId],
        )
      ).rows,
    ).toEqual([{ region_id: 'us-east' }]);
    expect(
      (
        await context.tenant.query(
          `SELECT enabled FROM ${context.tenant.table('monitors')} WHERE id = $1`,
          [monitorId],
        )
      ).rows[0],
    ).toEqual({
      enabled: 1,
    });

    const unavailableGrant = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 3, regions: 1, allowedRegionIds: ['eu-west'] }),
      },
    );
    expect(unavailableGrant.status).toBe(400);
    expect(await unavailableGrant.json()).toMatchObject({
      error: { code: 'region_unavailable' },
    });
  });

  it('rejects limit reductions that conflict with saved monitors and keeps their state', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:limitconflict11111111111',
      'conflict.bsky.social',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const created = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Keep paused monitor',
          url: 'https://keep.example.com',
          regionIds: ['eu-west', 'us-east'],
          intervalSeconds: 300,
          timeoutMs: 10000,
          enabled: false,
          outageThreshold: 2,
          recoveryThreshold: 1,
        }),
      },
    );
    expect(created.status).toBe(201);
    const conflict = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 0, regions: 1, allowedRegionIds: ['eu-west'] }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'limits_conflict' } });
    expect(
      (await context.tenant.query(`SELECT enabled FROM ${context.tenant.table('monitors')}`))
        .rows[0],
    ).toEqual({ enabled: 0 });
    const regionConflict = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ monitors: 3, regions: 1, allowedRegionIds: ['eu-west'] }),
      },
    );
    expect(regionConflict.status).toBe(409);
    expect(await regionConflict.json()).toMatchObject({ error: { code: 'limits_conflict' } });
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspace_product_limits')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 0,
    });
  });

  it('fences concurrent monitor creation at the configured workspace quota', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:limitrace1111111111111111',
      'race.bsky.social',
    );
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:lmkzmvv6sdxntwtyxpg7fqqq',
      'noz.am',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const limits = await fetchHosted(
      context,
      `/api/operator/workspaces/${workspaceId}/limits`,
      operator.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({
          monitors: 1,
          regions: 3,
          allowedRegionIds: ['eu-west', 'us-east', 'asia'],
        }),
      },
    );
    expect(limits.status).toBe(200);

    const create = (name: string) =>
      fetchHosted(
        context,
        '/api/monitors',
        owner.cookie,
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            url: `https://${name}.example.com`,
            regionIds: ['eu-west'],
            intervalSeconds: 300,
            timeoutMs: 10000,
            outageThreshold: 2,
            recoveryThreshold: 1,
          }),
        },
      );
    const responses = await Promise.all([create('first-race'), create('second-race')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      (
        await context.tenant.query(
          `SELECT count(*)::integer AS count FROM ${context.tenant.table('monitors')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 1,
    });
  });

  it('uses a DID-only principal DTO and ignores an inaccessible workspace header', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.bsky.social',
    );
    const response = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      user: Record<string, unknown>;
      workspace: { id: string };
    };
    expect(session.user).toEqual({ did: owner.did, handle: 'owner.bsky.social' });
    expect(session.user).not.toHaveProperty('email');

    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES ('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'other.bsky.social', 'active', $1, $2, $3)`,
      [now(), now(), now()],
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('workspaces')}(id, owner_did, name, state, plan, created_at, updated_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'Other', 'active', 'free', $1, $2)`,
      [now(), now()],
    );

    const denied = await fetchHosted(context, '/api/monitors', owner.cookie, {
      'x-uptime-workspace': '11111111-1111-4111-8111-111111111111',
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('blocks suspended users before provisioning or tenant dispatch', async () => {
    const context = await createHostedContext();
    const user = await authenticatedCookie(
      context.control,
      'did:plc:cccccccccccccccccccccccc',
      'suspended.bsky.social',
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, 'suspended', $3, $4, $5)`,
      [user.did, 'suspended.bsky.social', now(), now(), now()],
    );

    const response = await fetchHosted(context, '/api/auth/session', user.cookie);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'account_suspended',
    );
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('workspaces')} WHERE owner_did = $1`,
          [user.did],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });

  it('atomically caps distributed request budgets', async () => {
    const context = await createHostedContext();
    const connection = await fixture.openConnection();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        consumeBudget(index % 2 ? connection : context.controlDb, 'test:did', 5, 60),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(3);
    const row = (
      await context.control.query(
        `SELECT count FROM ${context.control.table('request_budgets')} WHERE key = $1`,
        ['test:did'],
      )
    ).rows[0] as { count: number };
    expect(row.count).toBe(5);
  });

  it('allocates one empty tenant slot per owner and verifies tenant identity', async () => {
    const context = await createHostedContext();
    const principal = { did: 'did:plc:dddddddddddddddddddddddd', handle: 'new.bsky.social' };
    const first = await ensureWorkspace(context.env, principal);
    const second = await ensureWorkspace(context.env, principal);
    expect(first.id).toBe(second.id);
    expect(first.state).toBe('active');
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('tenant_slots')} WHERE status = $1`,
          ['assigned'],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await context.tenant.query(
          `SELECT workspace_id, plan FROM ${context.tenant.table('workspace_metadata')} WHERE id = 1`,
        )
      ).rows[0],
    ).toEqual({
      workspace_id: first.id,
      plan: 'free',
    });
  });

  it('keeps a configured minimum of enabled slots available to allocation', async () => {
    const context = await createHostedContext();
    Object.assign(context.env, { MIN_AVAILABLE_SLOTS: '1' });
    await context.control.query(
      `UPDATE ${context.control.table('service_controls')} SET max_workspaces=1 WHERE id=1`,
    );
    const user = { did: 'did:plc:dddddddddddddddddddddddd', handle: 'new.bsky.social' };

    expect((await ensureWorkspace(context.env, user)).state).toBe('waiting_for_capacity');
    Object.assign(context.env, { MIN_AVAILABLE_SLOTS: '0' });
    expect((await ensureWorkspace(context.env, user)).state).toBe('active');
  });

  it('lets the operator assign an unused held staging slot to an interest signup', async () => {
    const context = await createHostedContext();
    Object.assign(context.env, {
      ENVIRONMENT: 'staging',
      MIN_AVAILABLE_SLOTS: '1',
    });
    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });
    const tenant = await addTenant(context, 'STAGING_TEST_DB_001', 'staging-test-001');
    await context.control.query(
      `INSERT INTO ${context.control.table('tenant_slot_controls')}(binding_name,admission_enabled) VALUES('STAGING_TEST_DB_001',0)`,
    );
    const target = {
      did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      handle: 'waiting.bsky.social',
    };
    await recordInterest(context.controlDb, target);
    const targetSession = await authenticatedCookie(context.control, target.did, target.handle);

    const response = await fetchHosted(
      context,
      '/api/operator/slots/STAGING_TEST_DB_001/assignment',
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ ownerDid: target.did }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'active',
      bindingName: 'STAGING_TEST_DB_001',
      ownerDid: target.did,
      ownerHandle: target.handle,
    });
    expect(
      (
        await tenant.query(
          `SELECT workspace_id FROM ${tenant.table('workspace_metadata')} WHERE id=1`,
        )
      ).rows[0],
    ).toMatchObject({
      workspace_id: expect.any(String),
    });
    const retry = await fetchHosted(
      context,
      '/api/operator/slots/STAGING_TEST_DB_001/assignment',
      operator.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ ownerDid: target.did }) },
    );
    expect(retry.status).toBe(200);
    expect(
      (
        await fetchHosted(
          context,
          '/api/operator/slots/STAGING_TEST_DB_001/assignment',
          targetSession.cookie,
          {},
          { method: 'POST', body: JSON.stringify({ ownerDid: target.did }) },
        )
      ).status,
    ).toBe(403);
  });

  it('keeps staging reserved slots out of normal allocation while preserving one public spare', async () => {
    const context = await createHostedContext();
    Object.assign(context.env, { ENVIRONMENT: 'staging', MIN_AVAILABLE_SLOTS: '1' });
    const bindings = [
      'TENANT_TWO',
      'STAGING_OPERATOR_DB',
      'STAGING_TEST_DB_001',
      'STAGING_TEST_DB_002',
    ];
    for (const bindingName of bindings) {
      await addTenant(context, bindingName, bindingName.toLowerCase());
    }
    const principal = {
      did: 'did:plc:cccccccccccccccccccccccc',
      handle: 'staging.bsky.social',
    };
    const workspace = await ensureWorkspace(context.env, principal);
    expect(workspace.state).toBe('active');
    expect(
      (
        await context.control.query(
          `SELECT binding_name FROM ${context.control.table('tenant_slots')} WHERE workspace_id=$1`,
          [workspace.id],
        )
      ).rows[0],
    ).toEqual({ binding_name: 'TENANT_ONE' });
  });

  it('keeps free monitor quotas in the tenant database transaction', async () => {
    const context = await createHostedContext();
    const workspace = await ensureWorkspace(context.env, {
      did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee',
      handle: 'quota.bsky.social',
    });
    const insert = (...values: unknown[]) =>
      context.tenant.query(
        `INSERT INTO ${context.tenant.table('monitors')} (id, name, url, interval_seconds, timeout_ms, enabled,
        dns_diagnostics_enabled, uptime_thresholds, outage_threshold, recovery_threshold, next_check_at)
       VALUES ($1, 'm', 'https://example.com', 300, 10000, 1, 0, '{}', 2, 1, $2)`,
        values,
      );
    for (let index = 0; index < 3; index += 1)
      await insert(`00000000-0000-4000-8000-00000000000${index}`, now());
    await expect(insert('00000000-0000-4000-8000-000000000009', now())).rejects.toThrow(
      'free_monitor_limit',
    );
    expect(workspace.state).toBe('active');
  });

  it('denies viewer writes even when they select a workspace they can read', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:ffffffffffffffffffffffff',
      'owner.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const viewer = await authenticatedCookie(
      context.control,
      'did:plc:gggggggggggggggggggggggg',
      'viewer.bsky.social',
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('users')}(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [viewer.did, 'viewer.bsky.social', now(), now(), now()],
    );
    await context.control.query(
      `INSERT INTO ${context.control.table('memberships')}(workspace_id, did, role, created_at) VALUES ($1, $2, $3, $4)`,
      [workspaceId, viewer.did, 'viewer', now()],
    );

    const response = await hostedFetch(
      new Request('https://api.example.com/api/monitors', {
        method: 'POST',
        headers: { cookie: viewer.cookie, 'x-uptime-workspace': workspaceId },
        body: JSON.stringify({}),
      }),
      context.env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('leaves one concurrent workspace allocation waiting when only one slot exists', async () => {
    const context = await createHostedContext();
    const connection = await fixture.openConnection();
    const [one, two] = await Promise.all([
      ensureWorkspace(context.env, {
        did: 'did:plc:hhhhhhhhhhhhhhhhhhhhhhhh',
        handle: 'one.bsky.social',
      }),
      ensureWorkspace(
        { ...context.env, controlDb: connection },
        {
          did: 'did:plc:iiiiiiiiiiiiiiiiiiiiiiii',
          handle: 'two.bsky.social',
        },
      ),
    ]);
    expect([one.state, two.state].sort()).toEqual(['active', 'waiting_for_capacity']);
    expect(
      (
        await context.control.query(
          `SELECT count(*)::integer AS count FROM ${context.control.table('tenant_slots')} WHERE status = 'assigned'`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it('deletes populated tenant rows before marking a workspace deleted', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:jjjjjjjjjjjjjjjjjjjjjjjj',
      'delete.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('monitors')} (id, name, url, interval_seconds, timeout_ms, enabled,
        dns_diagnostics_enabled, uptime_thresholds, outage_threshold, recovery_threshold, next_check_at)
       VALUES ('00000000-0000-4000-8000-000000000099', 'delete me', 'https://example.com', 300, 10000, 1, 0, '{}', 2, 1, $1)`,
      [now()],
    );

    const response = await hostedFetch(
      new Request('https://api.example.com/api/workspace', {
        method: 'DELETE',
        headers: { cookie: owner.cookie },
      }),
      context.env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(
      (
        await context.tenant.query(
          `SELECT count(*)::integer AS count FROM ${context.tenant.table('monitors')}`,
        )
      ).rows[0],
    ).toEqual({
      count: 0,
    });
    expect(
      (
        await context.control.query(
          `SELECT state FROM ${context.control.table('workspaces')} WHERE id = $1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ state: 'deleted' });
    expect(
      (
        await context.control.query(
          `SELECT status FROM ${context.control.table('tenant_slots')} WHERE workspace_id = $1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ status: 'deleting' });
  });

  it('accepts public HTTPS targets without ownership challenges and redacts public URLs', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:kkkkkkkkkkkkkkkkkkkkkkkk',
      'test.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const monitor = {
      name: 'Public test',
      url: 'https://example.com/private?token=secret',
      regionIds: ['eu-west'],
      intervalSeconds: 300,
      timeoutMs: 10000,
      isPublic: true,
      publicSlug: 'public-test',
    };
    const created = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify(monitor) },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { summary: { monitor: { id: string } } };
    const monitorId = createdBody.summary.monitor.id;
    const publicPath = `/api/monitors/public/public-test?workspace=${workspaceId}`;
    const report = await fetchHosted(context, publicPath, '');
    expect(report.status).toBe(200);
    const published = await report.text();
    expect(published).toContain('https://example.com');
    expect(published).not.toContain('token=secret');
    expect(published).not.toContain('/private');
    const updated = await fetchHosted(
      context,
      `/api/monitors/${monitorId}`,
      owner.cookie,
      {},
      {
        method: 'PATCH',
        body: JSON.stringify({ url: 'https://another.example/health' }),
      },
    );
    expect(updated.status, JSON.stringify(await updated.clone().json())).toBe(200);
    expect(
      (
        await context.tenant.query(
          `SELECT url FROM ${context.tenant.table('monitors')} WHERE id = $1`,
          [monitorId],
        )
      ).rows[0],
    ).toEqual({
      url: 'https://another.example/health',
    });
    await context.control.query(
      `UPDATE ${context.control.table('workspaces')} SET state = 'suspended' WHERE id = $1`,
      [workspaceId],
    );
    expect((await fetchHosted(context, publicPath, '')).status).toBe(404);
    const suspendedSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(await suspendedSession.json()).toMatchObject({
      workspace: { state: 'suspended' },
      usage: { monitors: 1 },
    });
  });

  it('marks a stale public monitor report unknown using the latest observation timestamp', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:staleeeeeeeeeeeeeeeeeeeee',
      'stale.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const monitorId = '11111111-1111-4111-8111-111111111116';
    const runId = '11111111-1111-4111-8111-111111111117';
    const observedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('monitors')}(id,name,url,interval_seconds,timeout_ms,is_public,public_slug,outage_threshold,recovery_threshold,next_check_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        monitorId,
        'Stale public monitor',
        'https://example.com',
        300,
        10000,
        1,
        'stale-public',
        2,
        1,
        observedAt,
        observedAt,
        observedAt,
      ],
    );
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('monitor_regions')}(monitor_id,region_id) VALUES($1,$2)`,
      [monitorId, 'eu-west'],
    );
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('check_runs')}(id,monitor_id,window_started_at,status,expected_region_count,expected_regions,monitor_url,timeout_ms,deadline_at,completed_at,finalized_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        runId,
        monitorId,
        observedAt,
        'complete',
        1,
        '["eu-west"]',
        'https://example.com',
        10000,
        observedAt,
        observedAt,
        observedAt,
      ],
    );
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('observations')}(id,check_run_id,monitor_id,region_id,scheduled_window,status,success,http_status,response_ms,total_ms,started_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        '11111111-1111-4111-8111-111111111118',
        runId,
        monitorId,
        'eu-west',
        observedAt,
        'success',
        1,
        200,
        100,
        120,
        observedAt,
        observedAt,
      ],
    );
    Object.assign(context.env, { REPORTS: {} as R2Bucket });
    const response = await fetchHosted(
      context,
      `/reports/public/monitors/${monitorId}.json?workspace=${workspaceId}`,
      '',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      latestObservationAt: observedAt,
      summary: { status: 'unknown', latestByRegion: { 'eu-west': { success: true } } },
    });
  });

  it('rejects private or non-HTTPS targets and atomically caps notification test attempts', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:llllllllllllllllllllllll',
      'test.bsky.social',
    );
    await fetchHosted(context, '/api/auth/session', owner.cookie);
    const privateTarget = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Private target',
          url: 'https://127.0.0.1',
          regionIds: ['eu-west'],
          intervalSeconds: 300,
          timeoutMs: 10000,
        }),
      },
    );
    expect(privateTarget.status).toBe(400);
    expect(await privateTarget.json()).toMatchObject({ error: { code: 'forbidden_address' } });
    const nonHttps = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'HTTP target',
          url: 'http://example.com',
          regionIds: ['eu-west'],
          intervalSeconds: 300,
          timeoutMs: 10000,
        }),
      },
    );
    expect(nonHttps.status).toBe(400);
    expect(await nonHttps.json()).toMatchObject({ error: { code: 'target_policy' } });
    const wrongPort = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Nonstandard port',
          url: 'https://example.com:8443',
          regionIds: ['eu-west'],
          intervalSeconds: 300,
          timeoutMs: 10000,
        }),
      },
    );
    expect(wrongPort.status).toBe(400);
    expect(await wrongPort.json()).toMatchObject({ error: { code: 'target_policy' } });
    const targetsRoute = await fetchHosted(context, '/api/workspace/targets', owner.cookie);
    expect(targetsRoute.status).toBe(404);
    const path = '/api/notification-services/11111111-1111-4111-8111-111111111113/test';
    for (let index = 0; index < 3; index++)
      expect((await fetchHosted(context, path, owner.cookie, {}, { method: 'POST' })).status).toBe(
        404,
      );
    expect((await fetchHosted(context, path, owner.cookie, {}, { method: 'POST' })).status).toBe(
      429,
    );
  });

  it('scopes report objects to the workspace and rejects snapshots containing removed private monitors', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm',
      'reports.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const pageId = '11111111-1111-4111-8111-111111111114';
    await context.tenant.query(
      `INSERT INTO ${context.tenant.table('status_pages')}(id,title,public_slug) VALUES($1,$2,$3)`,
      [pageId, 'Services', 'services'],
    );
    const accessed: string[] = [];
    let monitorIds: string[] = [];
    const reports = {
      async get(key: string) {
        accessed.push(key);
        const data = key.endsWith('cohort.json')
          ? { generation: '123' }
          : key.endsWith('/status-pages.json')
            ? { statusPages: [{ id: pageId, publicSlug: 'services' }] }
            : {
                statusPage: {
                  id: pageId,
                  publicSlug: 'services',
                  groups: [{ monitors: monitorIds.map((id) => ({ id })) }],
                },
              };
        return {
          async json<T>() {
            return data as T;
          },
        };
      },
    } as unknown as R2Bucket;
    Object.assign(context.env, { REPORTS: reports });
    const path = `/reports/public/status-pages/${pageId}.json?workspace=${workspaceId}`;
    expect((await fetchHosted(context, path, '')).status).toBe(200);
    expect(accessed).toContain(
      `tenants/${workspaceId}/public/cohorts/123/status-pages/services.json`,
    );
    expect(accessed.every((key) => key.startsWith(`tenants/${workspaceId}/`))).toBe(true);
    monitorIds = ['11111111-1111-4111-8111-111111111115'];
    expect((await fetchHosted(context, path, '')).status).toBe(503);
    await context.tenant.query(
      `DELETE FROM ${context.tenant.table('status_pages')} WHERE id = $1`,
      [pageId],
    );
    expect((await fetchHosted(context, path, '')).status).toBe(404);
    const index = await fetchHosted(
      context,
      `/reports/public/status-pages.json?workspace=${workspaceId}`,
      '',
    );
    expect(await index.json()).toMatchObject({ statusPages: [] });
  });

  it('fences private mutations and defers deletion until an existing operation drains', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:nnnnnnnnnnnnnnnnnnnnnnnn',
      'leases.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    await context.control.query(
      `UPDATE ${context.control.table('workspaces')} SET execution_lease_token = 'in-flight', execution_lease_until = '2099-01-01T00:00:00.000Z' WHERE id = $1`,
      [workspaceId],
    );
    const mutation = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      { method: 'POST', body: '{}' },
    );
    expect(mutation.status).toBe(409);
    expect(await mutation.json()).toMatchObject({ error: { code: 'workspace_busy' } });
    const deletion = await fetchHosted(
      context,
      '/api/workspace',
      owner.cookie,
      {},
      { method: 'DELETE' },
    );
    expect(deletion.status).toBe(202);
    expect(await deletion.json()).toEqual({ state: 'deleting' });
    await context.control.query(
      `UPDATE ${context.control.table('workspaces')} SET execution_lease_token = NULL, execution_lease_until = NULL WHERE id = $1`,
      [workspaceId],
    );
    const complete = await fetchHosted(
      context,
      '/api/workspace',
      owner.cookie,
      {},
      { method: 'DELETE' },
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ state: 'deleted' });
  });
});

async function createHostedContext() {
  // Only the fixture owner resets disposable schemas; worker roles retain DML grants.
  for (const database of [
    fixture.control.fixture,
    ...Array.from(usedTenants, (index) => fixture.tenants[index]!),
  ]) {
    const relations = await database.adminDb.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename <> '_postgres_migrations'",
      [database.schema],
    );
    await database.adminDb.query(
      `TRUNCATE TABLE ${relations.rows.map(({ name }) => `${quotePostgresIdentifier(database.schema)}.${quotePostgresIdentifier(name)}`).join(', ')} CASCADE`,
    );
  }
  const control = fixture.control.db;
  await control.query(`INSERT INTO ${control.table('service_controls')}(id) VALUES(1)`);
  const env: CloudflareEnv & {
    controlDb: Database;
    catalog: ReturnType<typeof parsePostgresRuntimeCatalog>;
  } = {
    ...fixture.env,
    PUBLIC_ORIGIN: 'https://api.example.com',
    POSTGRES_RUNTIME_CATALOG: JSON.stringify({ controlSchema: control.schema, sources: [] }),
    controlDb: control,
    catalog: parsePostgresRuntimeCatalog(
      JSON.stringify({ controlSchema: control.schema, sources: [] }),
    ),
  };
  delete env.REGIONS_LIST;
  delete env.DISABLE_RATE_LIMIT;
  const context = {
    control,
    controlDb: control,
    tenant: fixture.tenants[0]!.db,
    env,
    used: new Set<number>(),
  };
  usedTenants = context.used;
  context.tenant = await addTenant(context, 'TENANT_ONE', 'tenant-one');
  return context;
}

async function addTenant(
  context: {
    control: Database;
    env: typeof fixture.env & { catalog: ReturnType<typeof parsePostgresRuntimeCatalog> };
    used: Set<number>;
  },
  bindingName: string,
  sourceDatabaseId: string,
  profile: RuntimePostgresProfile = 'full-hosted',
) {
  const index = fixture.catalog.sources.findIndex(
    (source, index) => source.profile === profile && !context.used.has(index),
  );
  if (index < 0) throw new Error('Hosted fixture pool exhausted');
  context.used.add(index);
  const tenant = fixture.tenants[index]!;
  const config = JSON.parse(context.env.POSTGRES_RUNTIME_CATALOG!);
  config.sources.push({ sourceDatabaseId, schema: tenant.schema, profile });
  context.env.POSTGRES_RUNTIME_CATALOG = JSON.stringify(config);
  context.env.catalog = parsePostgresRuntimeCatalog(context.env.POSTGRES_RUNTIME_CATALOG!);
  await context.control.query(
    `INSERT INTO ${context.control.table('postgres_tenant_registry')}(source_database_id,schema_name,status) VALUES($1,$2,'available')`,
    [sourceDatabaseId, tenant.schema],
  );
  await context.control.query(
    `INSERT INTO ${context.control.table('tenant_slots')}(binding_name,database_id,status) VALUES($1,$2,'available')`,
    [bindingName, sourceDatabaseId],
  );
  return tenant.db;
}

async function authenticatedCookie(control: Database, did: string, handle: string) {
  const token = `token-${did.slice(-8)}`;
  await control.query(
    `INSERT INTO ${control.table('atproto_login_sessions')}(token_hash, did, handle, expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      await hashSessionToken(token, 's'.repeat(32)),
      did,
      handle,
      '2099-01-01T00:00:00.000Z',
      now(),
      now(),
    ],
  );
  return { did, cookie: `uptime_atproto_session=${token}` };
}

async function fetchHosted(
  context: Awaited<ReturnType<typeof createHostedContext>>,
  path: string,
  cookie: string,
  extraHeaders: Record<string, string> = {},
  init: RequestInit = {},
) {
  const pending: Promise<unknown>[] = [];
  const response = await hostedFetch(
    new Request(`https://api.example.com${path}`, {
      ...init,
      headers: { cookie, ...extraHeaders },
    }),
    context.env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

function now() {
  return '2026-10-02T12:00:00.000Z';
}
