import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceTier,
  defaultProductCatalog,
  resolveEffectiveEntitlements,
  saveProductCatalog,
  syncTierEntitlements,
  type CloudflareEnv,
} from '@uptime/cloudflare';
import { type Database, pgAll, pgFirst, pgRun } from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
} from '@uptime/cloudflare/testing/postgres';
import { createStripeProvider } from './stripe-provider.js';
import {
  billingReadiness,
  billingWebhook,
  changeMockBillingPlan,
  confirmMockBilling,
  getWorkspaceBilling,
  manageBilling,
  reconcileDueBilling,
  startBillingCheckout,
  type BillingContext,
} from './workspace-billing.js';
import {
  createControlFixture,
  seedControlUser,
  seedControlWorkspace,
  type ControlTestFixture,
} from './testing/control-fixture.js';
import { resolveTestAdminUrl, TENANT_TABLES } from './testing/test-utils.js';

const regions = ['eu-west', 'us-east', 'asia'] as const;

let fixture: ControlTestFixture;

beforeAll(async () => {
  fixture = await createControlFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function crashOnStatement(db: Database, fragment: string, message: string) {
  const transaction = db.transaction.bind(db);
  let crash = true;
  vi.spyOn(db, 'transaction').mockImplementation((callback) =>
    transaction((tx) =>
      callback({
        schema: tx.schema,
        table: (name) => tx.table(name),
        transaction: (nested) => tx.transaction(nested),
        query: (sql, values) => {
          if (crash && sql.includes(fragment)) {
            crash = false;
            throw new Error(message);
          }
          return tx.query(sql, values);
        },
      }),
    ),
  );
}

async function resetTables() {
  await fixture.fixture.adminDb.query(
    `TRUNCATE TABLE
        ${fixture.db.table('workspace_billing')},
        ${fixture.db.table('billing_webhook_events')},
        ${fixture.db.table('workspace_events')},
        ${fixture.db.table('workspace_tier_assignments')},
        ${fixture.db.table('workspace_product_limits')},
        ${fixture.db.table('tenant_slots')},
        ${fixture.db.table('product_catalog_current')},
        ${fixture.db.table('product_catalog_revisions')},
        ${fixture.db.table('memberships')},
        ${fixture.db.table('workspaces')},
        ${fixture.db.table('users')},
        ${fixture.db.table('service_controls')}
      CASCADE`,
  );
  await pgRun(
    fixture.db,
    `INSERT INTO ${fixture.db.table('service_controls')} (id, admission_open, max_workspaces) VALUES (1, 1, 10)`,
  );
}

async function context(mode: 'mock' | 'stripe' = 'mock') {
  await resetTables();
  const timestamp = '2026-10-05T00:00:00.000Z';
  await seedControlUser(fixture.db, 'owner', 'owner.test', timestamp);
  await seedControlWorkspace(fixture.db, {
    workspaceId: 'w',
    ownerDid: 'owner',
    timestamp,
  });
  let now = Date.parse(timestamp);
  const c: BillingContext = {
    control: fixture.db,
    regions,
    now: () => now,
    env: {
      ENVIRONMENT: 'test',
      BILLING_MODE: mode,
      WEB_ORIGIN: 'https://app.example.com',
      STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop',
      STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnop',
      STRIPE_PRODUCT_IDS: JSON.stringify({
        '1:pro': 'prod_pro',
        '1:team': 'prod_team',
        '2:pro': 'prod_pro',
        '2:team': 'prod_team',
      }),
      STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_valid',
      STRIPE_PORTAL_POLICY: 'prorate-no-trials-period-end',
    } as unknown as CloudflareEnv,
  };
  return {
    c,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    now: () => Math.floor(now / 1000),
  };
}

async function stripeContext() {
  const ctx = await context('stripe');
  const catalog = defaultProductCatalog(regions);
  catalog.revision = 1;
  catalog.preview = false;
  catalog.billingMode = 'stripe';
  for (const plan of catalog.plans) {
    plan.revision = 1;
    plan.preview = false;
  }
  catalog.stripePriceIds = { pro: 'price_pro', team: 'price_team' };
  await saveProductCatalog(ctx.c.control, regions, catalog, 0, 'operator', 'Approved test catalog');
  const customers = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const cache = new Map<string, unknown>();
  const price = (id: string) => ({
    id,
    active: true,
    currency: 'usd',
    unit_amount: id === 'price_pro' ? 1900 : 4900,
    billing_scheme: 'per_unit',
    livemode: false,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: id.replace('price_', 'prod_'), active: true },
    metadata: {},
  });
  let pricePatch: Record<string, unknown> = {};
  let portalPatch: Record<string, unknown> = {};
  let unavailable = false;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    if (unavailable) return new Response('unavailable', { status: 503 });
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ''));
    const key = new Headers(init?.headers).get('idempotency-key');
    if (key && cache.has(key)) return Response.json(cache.get(key));
    let result: unknown;
    if (url.pathname.startsWith('/v1/prices/'))
      result = { ...price(url.pathname.split('/').at(-1)!), ...pricePatch };
    else if (url.pathname.startsWith('/v1/billing_portal/configurations/'))
      result = {
        id: 'bpc_valid',
        active: true,
        features: {
          subscription_update: {
            enabled: true,
            default_allowed_updates: ['price'],
            proration_behavior: 'create_prorations',
            products: [
              { product: 'prod_pro', prices: ['price_pro'] },
              { product: 'prod_team', prices: ['price_team'] },
            ],
          },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
        },
        ...portalPatch,
      };
    else if (url.pathname === '/v1/customers') {
      const customer = {
        id: 'cus_workspace',
        livemode: false,
        metadata: { workspaceId: body.get('metadata[workspaceId]'), mode: 'stripe' },
      };
      customers.set(customer.id, customer);
      result = customer;
    } else if (url.pathname === '/v1/checkout/sessions') {
      const session = {
        id: `cs_${sessions.size + 1}`,
        customer: body.get('customer'),
        subscription: null,
        client_reference_id: body.get('client_reference_id'),
        metadata: {
          workspaceId: body.get('metadata[workspaceId]'),
          planId: body.get('metadata[planId]'),
          revision: body.get('metadata[revision]'),
          mode: body.get('metadata[mode]'),
        },
        payment_status: 'unpaid',
        status: 'open',
        expires_at: Number(body.get('expires_at')),
        url: 'https://checkout.stripe.com/c/pay',
      };
      sessions.set(session.id, session);
      result = session;
    } else if (url.pathname.startsWith('/v1/checkout/sessions/'))
      result = sessions.get(url.pathname.split('/').at(-1)!);
    else if (url.pathname.startsWith('/v1/subscriptions/')) {
      const sub = subscriptions.get(url.pathname.split('/').at(-1)!);
      if (sub && init?.method === 'POST')
        sub.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
      result = sub;
    } else if (url.pathname === '/v1/billing_portal/sessions')
      result = {
        id: 'bps_test',
        url: 'https://billing.stripe.com/p/session',
        customer: body.get('customer'),
        return_url: body.get('return_url'),
      };
    else throw new Error(`Unexpected Stripe request ${url.pathname}`);
    if (!result) return new Response('{}', { status: 404 });
    if (key) cache.set(key, structuredClone(result));
    return Response.json(result);
  });
  ctx.c.provider = createStripeProvider(
    {
      mode: 'stripe',
      environment: 'test',
      appOrigin: 'https://app.example.com',
      secretKey: String(ctx.c.env.STRIPE_SECRET_KEY),
      webhookSecret: String(ctx.c.env.STRIPE_WEBHOOK_SECRET),
      allowlistedPriceIds: ['price_pro', 'price_team'],
    },
    { fetch: fetcher, nowMs: () => ctx.now() * 1000 },
  );
  function complete(sessionId: string, subscriptionId = 'sub_one', status = 'active', paid = true) {
    const session = sessions.get(sessionId)!;
    session.subscription = subscriptionId;
    session.status = 'complete';
    session.payment_status = paid ? 'paid' : 'unpaid';
    const sub = {
      id: subscriptionId,
      customer: 'cus_workspace',
      status,
      cancel_at_period_end: false,
      livemode: false,
      metadata: {
        workspaceId: 'w',
        planId: session.metadata && (session.metadata as Record<string, string>).planId,
        revision: '1',
        mode: 'stripe',
      },
      items: {
        data: [
          {
            price: { id: `price_${(session.metadata as Record<string, string>).planId}` },
            quantity: 1,
            current_period_end: ctx.now() + 30 * 86400,
          },
        ],
      },
    };
    subscriptions.set(subscriptionId, sub);
    return sub;
  }
  async function event(
    id = 'evt_one',
    type = 'customer.subscription.updated',
    subscription = 'sub_one',
    customer = 'cus_workspace',
    extra: Record<string, unknown> = {},
    envelope: Record<string, unknown> = {},
  ) {
    const raw = JSON.stringify({
      id,
      type,
      created: ctx.now(),
      livemode: false,
      ...envelope,
      data: {
        object: {
          id: type.startsWith('customer.subscription.') ? subscription : 'in_one',
          customer,
          subscription,
          ...extra,
        },
      },
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(ctx.c.env.STRIPE_WEBHOOK_SECRET)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ctx.now()}.${raw}`)),
    );
    return new Request('https://api.example.com/api/billing/webhook', {
      method: 'POST',
      headers: {
        'stripe-signature': `t=${ctx.now()},v1=${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      },
      body: raw,
    });
  }
  return {
    ...ctx,
    fetcher,
    sessions,
    subscriptions,
    customers,
    complete,
    event,
    pricePatch: (value: Record<string, unknown>) => {
      pricePatch = value;
    },
    portalPatch: (value: Record<string, unknown>) => {
      portalPatch = value;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

async function createTenantDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const migrationsDir = new URL(
    '../../../packages/cloudflare/src/postgres/migrations/tenant/',
    import.meta.url,
  );
  const migrations = await loadPostgresMigrations(migrationsDir);
  const testDb = await createPostgresTestDatabase({
    adminConnectionString: resolveTestAdminUrl(),
    migrations,
    profile: 'full-hosted',
    tables: TENANT_TABLES,
  });
  return {
    db: testDb.db,
    close: () => testDb.close(),
  };
}

describe('durable workspace billing (native PostgreSQL)', { timeout: 180_000 }, () => {
  it('never creates customers or grants entitlements on settings GET/return query', async () => {
    const ctx = await context();
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription).toBeNull();
    const billingRows = await fixture.db.query(
      `SELECT * FROM ${fixture.db.table('workspace_billing')}`,
    );
    expect(billingRows.rows.length).toBe(0);
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    expect(checkout).toMatchObject({ mode: 'mock', simulation: true, revision: 1 });
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan.tierId).toBe('free');
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('free');
    const catalogRows = await fixture.db.query(
      `SELECT * FROM ${fixture.db.table('product_catalog_revisions')}`,
    );
    expect(catalogRows.rows.length).toBe(1);
    expect(await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0)).toEqual(checkout);
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'team', 1)).rejects.toMatchObject({
      code: 'checkout_pending',
    });
  });

  it('persists mock purchase across fresh provider contexts and consumes nonce only once', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    const fresh = {
      ...ctx.c,
      provider: createStripeProvider({
        mode: 'mock',
        environment: 'test',
        appOrigin: 'https://app.example.com',
      }),
    };
    const result = await confirmMockBilling(
      fresh,
      'w',
      'owner',
      checkout.sessionId!,
      checkout.nonce!,
    );
    expect(result.subscription).toMatchObject({ status: 'active', tierId: 'pro', revision: 1 });
    expect(result.effectivePlan.tierId).toBe('pro');
    await expect(
      confirmMockBilling(fresh, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
    ).rejects.toMatchObject({ code: 'mock_session_used' });
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'team', 1)).rejects.toMatchObject({
      code: 'subscription_exists',
    });
    expect(await manageBilling(fresh, 'w', 'owner', 'portal')).toMatchObject({
      url: 'https://app.example.com/settings#subscription',
      simulation: true,
    });
  });

  it('returns pinned pricing snapshots after catalog changes and switches the existing mock plan', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'team', 0);
    const next = defaultProductCatalog(regions);
    next.revision = 2;
    next.plans.forEach((plan) => {
      plan.revision = 2;
      if (plan.id === 'team') {
        plan.name = 'Edited team';
        plan.price.amount = 5900;
      }
    });
    await saveProductCatalog(ctx.c.control, regions, next, 1, 'operator', 'New pricing');
    const settings = await getWorkspaceBilling(ctx.c, 'w', true);
    expect(settings.mockSession?.plan).toMatchObject({ revision: 1, price: { amount: 4900 } });
    expect(checkout.plan.price.amount).toBe(4900);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    const before = await pgFirst(
      fixture.db,
      `SELECT subscription_id, period_end FROM ${fixture.db.table('workspace_billing')}`,
    );
    const changed = await changeMockBillingPlan(ctx.c, 'w', 'owner', 'pro', 2);
    expect(changed.subscription?.plan).toMatchObject({
      id: 'pro',
      revision: 2,
      price: { amount: 1900 },
    });
    expect(changed.effectivePlan).toMatchObject({ tierId: 'pro', revision: 2 });
    const after = await pgFirst(
      fixture.db,
      `SELECT subscription_id, period_end FROM ${fixture.db.table('workspace_billing')}`,
    );
    expect(after).toEqual(before);
  });

  it('never bills imported legacy bindings or changes their ownership', async () => {
    const ctx = await context();
    await pgRun(
      fixture.db,
      `INSERT INTO ${fixture.db.table('tenant_slots')} (binding_name, workspace_id, database_id, status)
       VALUES ('LEGACY_MAIN_DB', 'w', 'legacy', 'assigned')`,
    );
    const result = await getWorkspaceBilling(ctx.c, 'w', true);
    expect(result).toMatchObject({
      legacyExempt: true,
      subscription: null,
      actions: { checkout: false, portal: false },
    });
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0)).rejects.toMatchObject({
      code: 'legacy_exempt',
    });
    const billingRows = await fixture.db.query(
      `SELECT * FROM ${fixture.db.table('workspace_billing')}`,
    );
    expect(billingRows.rows.length).toBe(0);
    const ws = await pgFirst<{ owner_did: string }>(
      fixture.db,
      `SELECT owner_did FROM ${fixture.db.table('workspaces')} WHERE id = 'w'`,
    );
    expect(ws?.owner_did).toBe('owner');
  });

  it('rejects expired/nonmatching nonce and permits explicit checkout cancellation or payment failure without a grant', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await expect(
      confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, 'wrong'),
    ).rejects.toMatchObject({ code: 'mock_session_used' });
    ctx.advance(1800);
    await expect(
      confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
    ).rejects.toMatchObject({ code: 'mock_session_expired' });
    const next = await startBillingCheckout(ctx.c, 'w', 'owner', 'team', 1);
    expect(next.sessionId).not.toBe(checkout.sessionId);
    await confirmMockBilling(ctx.c, 'w', 'owner', next.sessionId!, next.nonce!, 'cancel');
    const failed = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    await confirmMockBilling(
      ctx.c,
      'w',
      'owner',
      failed.sessionId!,
      failed.nonce!,
      'payment_failed',
    );
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan.tierId).toBe('free');
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription?.status).toBe('none');
    expect((await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1)).nonce).toBeTruthy();
  });

  it('starts a replacement mock subscription without the previous cancellation or grace', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    await manageBilling(ctx.c, 'w', 'owner', 'cancel');
    ctx.advance(30 * 86400);
    await reconcileDueBilling(ctx.c);
    const replacement = await startBillingCheckout(ctx.c, 'w', 'owner', 'team', 1);
    const settings = await confirmMockBilling(
      ctx.c,
      'w',
      'owner',
      replacement.sessionId!,
      replacement.nonce!,
    );
    expect(settings.subscription).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: false,
      graceUntil: null,
    });
    ctx.advance(30 * 86400);
    await reconcileDueBilling(ctx.c);
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan.tierId).toBe('team');
  });

  it('keeps scheduled cancellation until deadline, resumes, and enforces grace automatically while preserving tenant resources', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    await manageBilling(ctx.c, 'w', 'owner', 'cancel');
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan.tierId).toBe('pro');
    await manageBilling(ctx.c, 'w', 'owner', 'resume');
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription?.cancelAtPeriodEnd).toBe(
      false,
    );
    const tenant = await createTenantDatabase();
    try {
      await pgRun(
        tenant.db,
        `INSERT INTO ${tenant.db.table('workspace_metadata')} (id, workspace_id, monitor_limit, region_limit, allowed_region_ids, seat_limit, status_page_limit, notification_destination_limit, custom_domain_limit, tier_id, catalog_revision, entitlement_generation, updated_at)
         VALUES (1, 'w', 10, 3, '["eu-west","us-east","asia"]', 5, 2, 2, 1, 'pro', 1, 0, '2026-10-05T00:00:00Z')`,
      );
      await syncTierEntitlements(
        tenant.db,
        await resolveEffectiveEntitlements(ctx.c.control, 'w', regions),
      );
      await pgRun(
        tenant.db,
        `INSERT INTO ${tenant.db.table('monitors')}
          (id, name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled, outage_threshold, recovery_threshold, next_check_at, created_at, updated_at)
         VALUES ('m', 'Keep me', 'https://example.com', 300, 10000, 1, 0, 2, 1, '2026-10-05', '2026-10-05', '2026-10-05')`,
      );
      const failed = await manageBilling(ctx.c, 'w', 'owner', 'payment_failed');
      expect(failed).toHaveProperty('subscription.graceUntil', ctx.now() + 7 * 86400);
      ctx.advance(7 * 86400);
      expect(await reconcileDueBilling(ctx.c)).toEqual({ scanned: 1, reconciled: 1 });
      const effective = await resolveEffectiveEntitlements(ctx.c.control, 'w', regions);
      expect(effective).toMatchObject({ tierId: 'free', revision: 0 });
      await syncTierEntitlements(tenant.db, effective);
      const monitor = await pgFirst<{ name: string; url: string; enabled: number }>(
        tenant.db,
        `SELECT name, url, enabled FROM ${tenant.db.table('monitors')} WHERE id = 'm'`,
      );
      expect(monitor).toEqual({
        name: 'Keep me',
        url: 'https://example.com',
        enabled: 1,
      });
    } finally {
      await tenant.close();
    }
  });

  it('enforces mock cancellation at actual period end without a dashboard read', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    await manageBilling(ctx.c, 'w', 'owner', 'cancel');
    ctx.advance(30 * 86400);
    await reconcileDueBilling(ctx.c);
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('free');
  });

  it('fails closed on mismatched mode, production mock, missing credentials and draft real catalog', async () => {
    const ctx = await context();
    ctx.c.env.ENVIRONMENT = 'production';
    expect((await billingReadiness(ctx.c)).ready).toBe(false);
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0)).rejects.toMatchObject({
      code: 'billing_setup',
    });
    const real = await stripeContext();
    real.c.env.STRIPE_SECRET_KEY = '';
    expect((await billingReadiness(real.c)).ready).toBe(false);
    real.c.env.STRIPE_SECRET_KEY = 'sk_test_abcdefghijklmnop';
    real.c.env.BILLING_MODE = 'mock';
    expect((await billingReadiness(real.c)).ready).toBe(false);
    const next = defaultProductCatalog(regions);
    next.billingMode = 'stripe';
    next.revision = 2;
    next.plans.forEach((p) => {
      p.revision = 2;
    });
    real.c.env.BILLING_MODE = 'stripe';
    await saveProductCatalog(real.c.control, regions, next, 1, 'operator', 'Restore draft');
    expect((await billingReadiness(real.c)).ready).toBe(false);
  });

  it.each([
    { unit_amount: 1901 },
    { currency: 'eur' },
    { active: false },
    { product: { id: 'prod_wrong', active: true } },
    { product: { id: 'prod_pro', active: false } },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    { billing_scheme: 'tiered' },
    { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } },
    { livemode: true },
  ])('rejects exact Stripe price mismatch before customer creation: %j', async (patch) => {
    const ctx = await stripeContext();
    ctx.pricePatch(patch);
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1)).rejects.toMatchObject({
      code: 'billing_setup',
    });
    expect(ctx.customers.size).toBe(0);
    expect(ctx.sessions.size).toBe(0);
  });

  it('validates Portal configuration capabilities and never publishes Stripe IDs', async () => {
    const ctx = await stripeContext();
    expect((await billingReadiness(ctx.c)).ready).toBe(true);
    const safe = JSON.stringify(await getWorkspaceBilling(ctx.c, 'w', true));
    expect(safe).not.toMatch(/price_pro|prod_pro|sk_test_|whsec_|cus_/);
    ctx.portalPatch({ active: false });
    expect((await billingReadiness(ctx.c)).ready).toBe(false);
  });

  it('serializes concurrent checkout and retries the same provider operation after a database crash', async () => {
    const ctx = await stripeContext();
    crashOnStatement(
      ctx.c.control,
      'checkout_id = $1, checkout_url = $2',
      'simulated PostgreSQL crash after Stripe',
    );
    await expect(startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1)).rejects.toThrow(
      'simulated PostgreSQL crash',
    );
    const results = await Promise.allSettled([
      startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1),
      startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(ctx.customers.size).toBe(1);
    expect(ctx.sessions.size).toBe(1);
    const keys = vi
      .mocked(ctx.fetcher)
      .mock.calls.filter((call) => String(call[0]).endsWith('/v1/checkout/sessions'))
      .map((call) => new Headers(call[1]?.headers).get('idempotency-key'));
    expect(new Set(keys).size).toBe(1);
  });

  it('does not grant an unpaid completed checkout and reconciles a later paid canonical subscription', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!, 'sub_one', 'incomplete', false);
    await billingWebhook(ctx.c, await ctx.event('evt_unpaid', 'checkout.session.completed'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('free');
    ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event('evt_paid', 'invoice.paid'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('pro');
  });

  it('deduplicates completed events and retries a pending event after execution lease conflict', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!);
    await pgRun(
      fixture.db,
      `UPDATE ${fixture.db.table('workspaces')} SET execution_lease_until = $1`,
      ['2099-01-01T00:00:00.000Z'],
    );
    await expect(billingWebhook(ctx.c, await ctx.event())).rejects.toMatchObject({ status: 503 });
    const pendingEvt = await pgFirst<{ state: string }>(
      fixture.db,
      `SELECT state FROM ${fixture.db.table('billing_webhook_events')}`,
    );
    expect(pendingEvt?.state).toBe('pending');
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription).toMatchObject({
      pendingReconciliation: true,
      activationError: 'assignment_conflict',
    });
    await pgRun(
      fixture.db,
      `UPDATE ${fixture.db.table('workspaces')} SET execution_lease_until = NULL`,
    );
    await billingWebhook(ctx.c, await ctx.event());
    const generation = (await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).generation;
    await billingWebhook(ctx.c, await ctx.event());
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).generation).toBe(
      generation,
    );
    const completedEvt = await pgFirst<{ state: string }>(
      fixture.db,
      `SELECT state FROM ${fixture.db.table('billing_webhook_events')}`,
    );
    expect(completedEvt?.state).toBe('completed');
  });

  it('repairs a crash after entitlement application without mistaking its own generation for an operator edit', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!);
    crashOnStatement(ctx.c.control, 'pending = 0', 'crash after assignment');
    await expect(billingWebhook(ctx.c, await ctx.event())).rejects.toThrow(
      'crash after assignment',
    );
    const generation = (await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).generation;
    await billingWebhook(ctx.c, await ctx.event());
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).generation).toBe(
      generation,
    );
    const billingRow = await pgFirst<{ pending: number; activation_error: string | null }>(
      fixture.db,
      `SELECT pending, activation_error FROM ${fixture.db.table('workspace_billing')}`,
    );
    expect(Number(billingRow?.pending)).toBe(0);
    expect(billingRow?.activation_error).toBeNull();
  });

  it.each([
    'wrong_customer',
    'wrong_mode',
    'wrong_price',
    'wrong_quantity',
    'multiple_items',
    'wrong_workspace',
  ])('preserves known-good tier on %s canonical subscription', async (scenario) => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    const sub = ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    if (scenario === 'wrong_customer') sub.customer = 'cus_attacker';
    if (scenario === 'wrong_mode') sub.livemode = true;
    if (scenario === 'wrong_workspace') sub.metadata.workspaceId = 'other';
    if (scenario === 'wrong_price') sub.items.data[0]!.price.id = 'price_unknown';
    if (scenario === 'wrong_quantity') sub.items.data[0]!.quantity = 2;
    if (scenario === 'multiple_items') sub.items.data.push(structuredClone(sub.items.data[0]!));
    await expect(billingWebhook(ctx.c, await ctx.event('evt_bad'))).rejects.toMatchObject({
      status: 503,
    });
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('pro');
    const evt = await pgFirst<{ state: string }>(
      fixture.db,
      `SELECT state FROM ${fixture.db.table('billing_webhook_events')} WHERE event_id = 'evt_bad'`,
    );
    expect(evt?.state).toBe('pending');
  });

  it('pins a purchase to its checkout revision when a newer catalog reuses its Price', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    const next = defaultProductCatalog(regions);
    next.revision = 2;
    next.preview = false;
    next.billingMode = 'stripe';
    next.stripePriceIds = { pro: 'price_pro', team: 'price_team' };
    for (const plan of next.plans) {
      plan.revision = 2;
      plan.preview = false;
    }
    next.plans.find((plan) => plan.id === 'pro')!.entitlements.monitors = 11;
    await saveProductCatalog(ctx.c.control, regions, next, 1, 'operator', 'Revised entitlements');
    const sub = ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan).toEqual({
      tierId: 'pro',
      revision: 1,
    });
    sub.status = 'canceled';
    await billingWebhook(ctx.c, await ctx.event('evt_cancel'));
    ctx.advance(86400);
    ctx.sessions.get(checkout.sessionId!)!.status = 'expired';
    const replacement = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 2);
    ctx.complete(replacement.sessionId!, 'sub_two');
    await billingWebhook(
      ctx.c,
      await ctx.event('evt_replace', 'customer.subscription.updated', 'sub_two'),
    );
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan).toEqual({
      tierId: 'pro',
      revision: 2,
    });
  });

  it('recognizes Portal plan changes by Price despite old subscription metadata and tolerates missing metadata', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    const sub = ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    sub.items.data[0]!.price.id = 'price_team';
    await billingWebhook(ctx.c, await ctx.event('evt_portal'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('team');
    sub.metadata = {} as typeof sub.metadata;
    await billingWebhook(ctx.c, await ctx.event('evt_metadata_missing'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('team');
  });

  it('refetches canonical state for out-of-order events and cannot revoke a replacement subscription', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    const old = ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    old.status = 'canceled';
    await billingWebhook(ctx.c, await ctx.event('evt_cancel', 'customer.subscription.deleted'));
    await billingWebhook(ctx.c, await ctx.event('evt_stale_active'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('free');
    ctx.advance(86400);
    ctx.sessions.get(checkout.sessionId!)!.status = 'expired';
    const replacement = await startBillingCheckout(ctx.c, 'w', 'owner', 'team', 1);
    ctx.complete(replacement.sessionId!, 'sub_two');
    await billingWebhook(
      ctx.c,
      await ctx.event('evt_replace', 'customer.subscription.updated', 'sub_two'),
    );
    await billingWebhook(ctx.c, await ctx.event('evt_old_delete', 'customer.subscription.deleted'));
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('team');
  });

  it('scheduler hook repairs pending webhook work without waiting for another HTTP delivery', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!);
    ctx.unavailable(true);
    await expect(billingWebhook(ctx.c, await ctx.event())).rejects.toThrow();
    ctx.unavailable(false);
    expect(await reconcileDueBilling(ctx.c)).toMatchObject({ reconciled: 1 });
    const evt = await pgFirst<{ state: string }>(
      fixture.db,
      `SELECT state FROM ${fixture.db.table('billing_webhook_events')}`,
    );
    expect(evt?.state).toBe('completed');
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('pro');
  });

  it('keeps entitlements during provider failure but enforces a previously known grace deadline', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    const sub = ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    sub.status = 'past_due';
    await billingWebhook(ctx.c, await ctx.event('evt_past_due', 'invoice.payment_failed'));
    ctx.unavailable(true);
    ctx.advance(3600);
    await reconcileDueBilling(ctx.c);
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('pro');
    ctx.advance(7 * 86400);
    await reconcileDueBilling(ctx.c);
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('free');
  });

  it('preflights operator capacity and exposes paid-but-pending activation without removing an override', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!);
    await pgRun(
      fixture.db,
      `INSERT INTO ${fixture.db.table('workspace_product_limits')} (workspace_id, monitors, regions, allowed_region_ids, updated_at)
       VALUES ('w', 1000, 3, $1, $2)`,
      [JSON.stringify(regions), '2026-10-05'],
    );
    await expect(billingWebhook(ctx.c, await ctx.event())).rejects.toMatchObject({ status: 503 });
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription).toMatchObject({
      status: 'active',
      activationError: 'capacity_exceeded',
      pendingReconciliation: true,
    });
    const limits = await pgFirst<{ monitors: number }>(
      fixture.db,
      `SELECT monitors FROM ${fixture.db.table('workspace_product_limits')}`,
    );
    expect(Number(limits?.monitors)).toBe(1000);
    const next = await context();
    await pgRun(
      fixture.db,
      `INSERT INTO ${fixture.db.table('workspace_product_limits')} (workspace_id, monitors, regions, allowed_region_ids, updated_at)
       VALUES ('w', 1000, 3, $1, $2)`,
      [JSON.stringify(regions), '2026-10-05'],
    );
    await expect(startBillingCheckout(next.c, 'w', 'owner', 'pro', 0)).rejects.toMatchObject({
      code: 'capacity_exceeded',
    });
  });

  it('does not overwrite later operator tier assignments during cancellation fallback', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    const effective = await resolveEffectiveEntitlements(ctx.c.control, 'w', regions);
    await applyWorkspaceTier(ctx.c.control, {
      workspaceId: 'w',
      tierId: 'team',
      revision: 1,
      expectedGeneration: effective.generation,
      actor: 'operator',
      reason: 'Manual contract',
      configuredRegionIds: regions,
    });
    await manageBilling(ctx.c, 'w', 'owner', 'cancel');
    ctx.advance(30 * 86400);
    await reconcileDueBilling(ctx.c);
    expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('team');
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription?.activationError).toBe(
      'operator_assignment',
    );
  });

  it('drops paid quotas at grace expiry even if an operator capacity override became unsafe', async () => {
    const ctx = await context();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
    await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
    await pgRun(
      fixture.db,
      `INSERT INTO ${fixture.db.table('workspace_product_limits')} (workspace_id, monitors, regions, allowed_region_ids, updated_at)
       VALUES ('w', 1000, 3, $1, $2)`,
      [JSON.stringify(regions), '2026-10-05'],
    );
    await manageBilling(ctx.c, 'w', 'owner', 'payment_failed');
    ctx.advance(7 * 86400);
    await reconcileDueBilling(ctx.c);
    expect(await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).toMatchObject({
      tierId: 'free',
      overrides: { monitors: 1000 },
      entitlements: { statusPages: 1, seats: 3, customDomains: 0 },
    });
  });

  it('automatically retries cancel after a crash at action completion with its stable provider key', async () => {
    const ctx = await stripeContext();
    const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
    ctx.complete(checkout.sessionId!);
    await billingWebhook(ctx.c, await ctx.event());
    crashOnStatement(
      ctx.c.control,
      'action_operation = NULL, action_kind = NULL',
      'crash after cancel',
    );
    await expect(manageBilling(ctx.c, 'w', 'owner', 'cancel')).rejects.toThrow(
      'crash after cancel',
    );
    expect(await reconcileDueBilling(ctx.c)).toMatchObject({ reconciled: 1 });
    expect((await getWorkspaceBilling(ctx.c, 'w', true)).subscription?.cancelAtPeriodEnd).toBe(
      true,
    );
    const calls = vi
      .mocked(ctx.fetcher)
      .mock.calls.filter(
        (call) =>
          String(call[0]).endsWith('/v1/subscriptions/sub_one') && call[1]?.method === 'POST',
      );
    expect(calls).toHaveLength(2);
    expect(
      new Set(calls.map((call) => new Headers(call[1]?.headers).get('idempotency-key'))).size,
    ).toBe(1);
  });

  it('rejects raw streamed bodies before verification and wrong mode/account envelopes', async () => {
    const ctx = await stripeContext();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
        controller.close();
      },
    });
    const request = new Request('https://api.example.com/api/billing/webhook', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(billingWebhook(ctx.c, request)).rejects.toMatchObject({ status: 413 });
    const wrong = await ctx.event('evt_wrong');
    const raw = (await wrong.text()).replace('"livemode":false', '"livemode":true');
    const signature = wrong.headers.get('stripe-signature')!;
    await expect(
      billingWebhook(
        ctx.c,
        new Request(wrong.url, {
          method: 'POST',
          headers: { 'stripe-signature': signature },
          body: raw,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      billingWebhook(
        ctx.c,
        await ctx.event(
          'evt_live',
          'customer.subscription.updated',
          'sub_one',
          'cus_workspace',
          {},
          { livemode: true },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      billingWebhook(
        ctx.c,
        await ctx.event(
          'evt_account',
          'customer.subscription.updated',
          'sub_one',
          'cus_workspace',
          {},
          { account: 'acct_other' },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  describe('concurrency and MVCC guarantees with multiple independent connections', () => {
    it('fences a checkout that returns after lease takeover and reuses the durable provider key', async () => {
      const ctx = await stripeContext();
      const conn2 = await fixture.openConnection();
      const originalFetch = vi.mocked(ctx.fetcher).getMockImplementation()!;
      let release!: () => void;
      let reached!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const providerReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let first = true;
      vi.mocked(ctx.fetcher).mockImplementation(async (input, init) => {
        const result = await originalFetch(input, init);
        if (first && String(input).endsWith('/v1/checkout/sessions')) {
          first = false;
          reached();
          await blocked;
        }
        return result;
      });
      const stale = startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
      const staleResult = stale.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await providerReached;
        ctx.advance(181);
        const replacement = await startBillingCheckout(
          { ...ctx.c, control: conn2 },
          'w',
          'owner',
          'pro',
          1,
        );
        expect(replacement.sessionId).toBe('cs_1');
      } finally {
        release();
      }
      expect(await staleResult).toMatchObject({ status: 409, code: 'billing_busy' });
      expect(ctx.customers.size).toBe(1);
      expect(ctx.sessions.size).toBe(1);
      expect(
        await pgFirst(
          fixture.db,
          `SELECT count(*)::integer AS count FROM ${fixture.db.table('workspace_events')} WHERE event='billing_checkout_started'`,
        ),
      ).toEqual({ count: 1 });
      const keys = vi
        .mocked(ctx.fetcher)
        .mock.calls.filter((call) => String(call[0]).endsWith('/v1/checkout/sessions'))
        .map((call) => new Headers(call[1]?.headers).get('idempotency-key'));
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
    });

    it('rolls back nonce consumption with a failed mock audit and safely retries once', async () => {
      const ctx = await context();
      const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);
      crashOnStatement(
        ctx.c.control,
        'INSERT INTO ' + ctx.c.control.table('workspace_events'),
        'mock audit crash',
      );
      await expect(
        confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
      ).rejects.toThrow('mock audit crash');
      expect((await getWorkspaceBilling(ctx.c, 'w', true)).effectivePlan.tierId).toBe('free');
      await confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!);
      await expect(
        confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
      ).rejects.toMatchObject({ code: 'mock_session_used' });
      expect(
        await pgFirst(
          fixture.db,
          `SELECT count(*)::integer AS count FROM ${fixture.db.table('workspace_events')} WHERE event='billing_mock_purchase'`,
        ),
      ).toEqual({ count: 1 });
    });

    it('handles concurrent webhook delivery of the same event with two independent connections (exactly-once processing)', async () => {
      const conn2 = await fixture.openConnection();
      const ctx = await stripeContext();
      const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 1);
      ctx.complete(checkout.sessionId!);

      const ctx2: BillingContext = {
        ...ctx.c,
        control: conn2,
      };

      const webhookReq1 = await ctx.event('evt_concurrent_1', 'invoice.paid');
      const rawBody = await webhookReq1.clone().text();
      const sig = webhookReq1.headers.get('stripe-signature')!;
      const makeReq = () =>
        new Request('https://api.example.com/api/billing/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': sig },
          body: rawBody,
        });

      const [res1, res2] = await Promise.allSettled([
        billingWebhook(ctx.c, makeReq()),
        billingWebhook(ctx2, makeReq()),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const rej of rejected) {
        expect(rej.reason).toMatchObject({ status: 503, code: 'billing_reconciliation_pending' });
      }

      // Exactly 1 webhook event record was processed and completed
      const events = await pgAll<{ state: string }>(
        fixture.db,
        `SELECT state FROM ${fixture.db.table('billing_webhook_events')} WHERE event_id = 'evt_concurrent_1'`,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.state).toBe('completed');

      // Entitlement is active at tier 'pro'
      expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).tierId).toBe('pro');
      const generation = (await resolveEffectiveEntitlements(ctx.c.control, 'w', regions))
        .generation;
      const audits = await pgAll(
        fixture.db,
        `SELECT id,event,details FROM ${fixture.db.table('workspace_events')} ORDER BY id`,
      );
      expect((await billingWebhook(ctx2, makeReq())).status).toBe(200);
      expect((await resolveEffectiveEntitlements(ctx.c.control, 'w', regions)).generation).toBe(
        generation,
      );
      expect(
        await pgAll(
          fixture.db,
          `SELECT id,event,details FROM ${fixture.db.table('workspace_events')} ORDER BY id`,
        ),
      ).toEqual(audits);
    });

    it('handles competing mock confirmations with the same nonce under two independent connections: one succeeds, one rejected with 409 without audit', async () => {
      const conn2 = await fixture.openConnection();
      const ctx = await context();
      const checkout = await startBillingCheckout(ctx.c, 'w', 'owner', 'pro', 0);

      const ctx2: BillingContext = {
        ...ctx.c,
        control: conn2,
      };

      const [res1, res2] = await Promise.allSettled([
        confirmMockBilling(ctx.c, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
        confirmMockBilling(ctx2, 'w', 'owner', checkout.sessionId!, checkout.nonce!),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(['billing_busy', 'mock_session_used']).toContain(rejected[0]!.reason.code);
      expect(rejected[0]!.reason.status).toBe(409);

      // Audit events for mock purchase must be exactly 1; rejected connection wrote ZERO audit
      const auditEvents = await pgAll<{ event: string }>(
        fixture.db,
        `SELECT event FROM ${fixture.db.table('workspace_events')} WHERE workspace_id = 'w' AND event = 'billing_mock_purchase'`,
      );
      expect(auditEvents).toHaveLength(1);
    });
  });
});
