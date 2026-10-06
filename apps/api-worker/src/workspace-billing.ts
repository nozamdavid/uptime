import {
  configuredMonitorBatch,
  evaluateCapacity,
  isImportedWorkspace,
  randomId,
  randomToken,
  readProductCatalog,
  resolveEffectiveEntitlements,
  saveProductCatalog,
  applyWorkspaceTier,
  ProductTierError,
  type CloudflareEnv,
  type PlanDefinition,
  type ProductCatalog,
} from '@uptime/cloudflare';
import { type Database, pgAll, pgBatch, pgFirst, pgRun } from '@uptime/cloudflare/postgres';
import type { RegionId } from '@uptime/regions';
import { HttpErrorLike, json, readJson } from './http.js';
import {
  createStripeProvider,
  StripeSignatureVerificationError,
  StripeValidationError,
  type StripeEnvironment,
  type StripeProvider,
  type StripeProviderMode,
  type StripeSubscription,
} from './stripe-provider.js';

export interface BillingContext {
  control: Database;
  env: CloudflareEnv;
  regions: readonly RegionId[];
  /** Test dependency only; routes always construct the trusted adapter. */
  provider?: StripeProvider;
  now?: () => number;
}

export interface BillingRow {
  workspace_id: string;
  mode: 'mock' | 'stripe';
  customer_id: string | null;
  subscription_id: string | null;
  status: string;
  tier_id: string | null;
  revision: number | null;
  period_end: number | null;
  cancel_at_period_end: number;
  grace_until: number | null;
  baseline_tier_id: string;
  baseline_revision: number;
  applied_generation: number;
  pending: number;
  activation_error: string | null;
  due_at: number | null;
  checkout_operation: string | null;
  checkout_tier_id: string | null;
  checkout_revision: number | null;
  checkout_id: string | null;
  checkout_url: string | null;
  checkout_nonce: string | null;
  checkout_expires: number | null;
  action_operation: string | null;
  action_kind: string | null;
  lease_token?: string | null | undefined;
  lease_until?: number | null | undefined;
  updated_at?: number | undefined;
}

interface RawBillingRow {
  workspace_id: string;
  mode: 'mock' | 'stripe';
  customer_id: string | null;
  subscription_id: string | null;
  status: string;
  tier_id: string | null;
  revision: number | string | null;
  period_end: number | string | null;
  cancel_at_period_end: number | string | null;
  grace_until: number | string | null;
  baseline_tier_id: string;
  baseline_revision: number | string;
  applied_generation: number | string;
  pending: number | string | null;
  activation_error: string | null;
  due_at: number | string | null;
  checkout_operation: string | null;
  checkout_tier_id: string | null;
  checkout_revision: number | string | null;
  checkout_id: string | null;
  checkout_url: string | null;
  checkout_nonce: string | null;
  checkout_expires: number | string | null;
  action_operation: string | null;
  action_kind: string | null;
  lease_token?: string | null;
  lease_until?: number | string | null;
  updated_at?: number | string;
}

function mapBillingRow(raw: RawBillingRow | null | undefined): BillingRow | null {
  if (!raw) return null;
  const row: BillingRow = {
    workspace_id: raw.workspace_id,
    mode: raw.mode,
    customer_id: raw.customer_id,
    subscription_id: raw.subscription_id,
    status: raw.status,
    tier_id: raw.tier_id,
    revision: raw.revision !== null && raw.revision !== undefined ? Number(raw.revision) : null,
    period_end:
      raw.period_end !== null && raw.period_end !== undefined ? Number(raw.period_end) : null,
    cancel_at_period_end: Number(raw.cancel_at_period_end ?? 0),
    grace_until:
      raw.grace_until !== null && raw.grace_until !== undefined ? Number(raw.grace_until) : null,
    baseline_tier_id: raw.baseline_tier_id,
    baseline_revision: Number(raw.baseline_revision),
    applied_generation: Number(raw.applied_generation),
    pending: Number(raw.pending ?? 0),
    activation_error: raw.activation_error,
    due_at: raw.due_at !== null && raw.due_at !== undefined ? Number(raw.due_at) : null,
    checkout_operation: raw.checkout_operation,
    checkout_tier_id: raw.checkout_tier_id,
    checkout_revision:
      raw.checkout_revision !== null && raw.checkout_revision !== undefined
        ? Number(raw.checkout_revision)
        : null,
    checkout_id: raw.checkout_id,
    checkout_url: raw.checkout_url,
    checkout_nonce: raw.checkout_nonce,
    checkout_expires:
      raw.checkout_expires !== null && raw.checkout_expires !== undefined
        ? Number(raw.checkout_expires)
        : null,
    action_operation: raw.action_operation,
    action_kind: raw.action_kind,
    lease_token: raw.lease_token ?? null,
    lease_until:
      raw.lease_until !== null && raw.lease_until !== undefined ? Number(raw.lease_until) : null,
  };
  if (raw.updated_at !== null && raw.updated_at !== undefined) {
    row.updated_at = Number(raw.updated_at);
  }
  return row;
}

const clock = (c: BillingContext) => Math.floor((c.now?.() ?? Date.now()) / 1000);
const setting = (c: BillingContext, key: string) =>
  typeof c.env[key] === 'string' ? (c.env[key] as string) : '';

function fail(status: number, code: string, message: string): never {
  throw new HttpErrorLike(status, code, message);
}

async function isWorkspaceLegacyExempt(control: Database, workspaceId: string): Promise<boolean> {
  try {
    const row = await pgFirst(
      control,
      `SELECT 1 FROM ${control.table('tenant_slots')}
       WHERE workspace_id = $1 AND binding_name IN ('STAGING_IMPORTED_DB', 'PRODUCTION_IMPORTED_DB', 'LEGACY_MAIN_DB')`,
      [workspaceId],
    );
    if (row) return true;
  } catch {
    // tenant_slots might not exist in every scope
  }
  return isImportedWorkspace(control, workspaceId);
}

async function load(c: BillingContext, id: string): Promise<BillingRow | null> {
  const raw = await pgFirst<RawBillingRow>(
    c.control,
    `SELECT * FROM ${c.control.table('workspace_billing')} WHERE workspace_id = $1`,
    [id],
  );
  return mapBillingRow(raw);
}

async function loadBySubscriptionId(
  c: BillingContext,
  subscriptionId: string,
): Promise<BillingRow | null> {
  const raw = await pgFirst<RawBillingRow>(
    c.control,
    `SELECT * FROM ${c.control.table('workspace_billing')} WHERE subscription_id = $1`,
    [subscriptionId],
  );
  return mapBillingRow(raw);
}

async function loadByCustomerId(c: BillingContext, customerId: string): Promise<BillingRow | null> {
  const raw = await pgFirst<RawBillingRow>(
    c.control,
    `SELECT * FROM ${c.control.table('workspace_billing')} WHERE customer_id = $1`,
    [customerId],
  );
  return mapBillingRow(raw);
}

function origin(c: BillingContext) {
  const value = setting(c, 'WEB_ORIGIN');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(setting(c, 'ENVIRONMENT') === 'development' && url.protocol === 'http:'))
  )
    fail(503, 'billing_setup', 'Configure a trusted WEB_ORIGIN for billing');
  return url.origin;
}

function productMappings(c: BillingContext): Record<string, string> {
  try {
    const value: unknown = JSON.parse(setting(c, 'STRIPE_PRODUCT_IDS') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && /^prod_[A-Za-z0-9_]+$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function provider(c: BillingContext, mode: StripeProviderMode, catalog: ProductCatalog) {
  if (c.provider) return c.provider;
  return createStripeProvider({
    mode,
    environment: setting(c, 'ENVIRONMENT') as StripeEnvironment,
    appOrigin: origin(c),
    secretKey: setting(c, 'STRIPE_SECRET_KEY'),
    webhookSecret: setting(c, 'STRIPE_WEBHOOK_SECRET'),
    expectedAccountId: setting(c, 'STRIPE_ACCOUNT_ID') || undefined,
    allowlistedPriceIds: Object.values(catalog.stripePriceIds ?? {}),
    timeoutMs: 8000,
  });
}

function live(c: BillingContext) {
  return /^(sk|rk)_live_/.test(setting(c, 'STRIPE_SECRET_KEY'));
}

async function validatePrice(
  c: BillingContext,
  p: StripeProvider,
  catalog: ProductCatalog,
  plan: PlanDefinition,
) {
  const priceId = catalog.stripePriceIds?.[plan.id];
  const productId = productMappings(c)[`${catalog.revision}:${plan.id}`];
  if (!priceId || !productId)
    fail(
      503,
      'billing_setup',
      `Configure Price and Product mappings for ${plan.id} revision ${catalog.revision}`,
    );
  const price = await p.getPrice(priceId);
  if (
    !price ||
    !price.active ||
    price.productActive !== true ||
    price.productId !== productId ||
    price.currency !== plan.price.currency ||
    price.unitAmount !== plan.price.amount ||
    price.interval !== 'month' ||
    price.intervalCount !== 1 ||
    price.billingScheme !== 'per_unit' ||
    price.usageType !== 'licensed' ||
    price.livemode !== live(c)
  )
    fail(
      503,
      'billing_setup',
      `Stripe Price/Product does not match ${plan.id} revision ${catalog.revision}; update the server mapping before checkout`,
    );
  return priceId;
}

/** Readiness contains only safe configuration reasons, never adapter exceptions or IDs. */
export async function billingReadiness(c: BillingContext, catalog?: ProductCatalog) {
  catalog ??= await readProductCatalog(c.control, c.regions);
  const mode = catalog.billingMode;
  const setupReasons: string[] = [];
  if (mode === 'disabled') setupReasons.push('Billing is disabled');
  if (setting(c, 'BILLING_MODE') !== mode)
    setupReasons.push('Set trusted BILLING_MODE to match the catalog');
  if (!['production', 'staging', 'test', 'development'].includes(setting(c, 'ENVIRONMENT')))
    setupReasons.push('Configure the deployment environment');
  if (mode === 'mock' && !['staging', 'test', 'development'].includes(setting(c, 'ENVIRONMENT')))
    setupReasons.push('Simulation is available only in staging, test or development');
  if (mode === 'stripe') {
    if (
      catalog.preview ||
      catalog.revision === 0 ||
      catalog.plans.some((p) => p.active && p.published && p.price.amount > 0 && p.preview)
    )
      setupReasons.push('Publish an approved catalog before enabling Stripe');
    if (!setting(c, 'STRIPE_SECRET_KEY') || !setting(c, 'STRIPE_WEBHOOK_SECRET'))
      setupReasons.push('Configure Stripe credentials and webhook verification');
    if (
      !/^bpc_[A-Za-z0-9_]+$/.test(setting(c, 'STRIPE_PORTAL_CONFIGURATION_ID')) ||
      setting(c, 'STRIPE_PORTAL_POLICY') !== 'prorate-no-trials-period-end'
    )
      setupReasons.push(
        'Configure an approved Portal with prorations, no trials and cancellation at period end',
      );
  }
  try {
    origin(c);
  } catch {
    setupReasons.push('Configure a trusted WEB_ORIGIN');
  }
  try {
    graceSeconds(c);
  } catch {
    setupReasons.push('BILLING_GRACE_DAYS must be an integer from 0 to 30');
  }
  if (setupReasons.length === 0) {
    try {
      const p = provider(c, mode, catalog);
      if (!p.isBillingReady) setupReasons.push('Billing provider is not ready');
      if (mode === 'stripe')
        await Promise.all(
          catalog.plans
            .filter((plan) => plan.active && plan.published && plan.price.amount > 0)
            .map((plan) => validatePrice(c, p, catalog!, plan)),
        );
      if (mode === 'stripe') {
        const portal = await p.getPortalConfiguration(setting(c, 'STRIPE_PORTAL_CONFIGURATION_ID'));
        if (
          !portal.active ||
          !portal.updatesEnabled ||
          !portal.cancellationAtPeriodEnd ||
          portal.prorationBehavior !== 'create_prorations' ||
          catalog.plans.some(
            (plan) =>
              plan.active &&
              plan.published &&
              plan.price.amount > 0 &&
              !portal.allowedPriceIds.includes(catalog!.stripePriceIds?.[plan.id] ?? ''),
          )
        )
          setupReasons.push(
            'Portal must enable mapped plan changes with prorations and cancellation at period end',
          );
      }
    } catch {
      setupReasons.push(
        'Validate Stripe credentials and exact active monthly Price/Product mappings',
      );
    }
  }
  return { mode, ready: setupReasons.length === 0, setupReasons, simulation: mode === 'mock' };
}

async function requireReady(c: BillingContext, catalog: ProductCatalog) {
  const current = await readProductCatalog(c.control, c.regions);
  if (current.billingMode !== catalog.billingMode)
    fail(503, 'billing_setup', 'Selected contract billing mode differs from the current catalog');
  const readiness = await billingReadiness(c, catalog);
  if (!readiness.ready) fail(503, 'billing_setup', readiness.setupReasons.join('; '));
  return provider(c, readiness.mode, catalog);
}

async function audit(
  db: Database,
  id: string,
  actor: string,
  action: string,
  simulation: boolean,
  nowSeconds: number,
) {
  await pgRun(
    db,
    `INSERT INTO ${db.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomId(),
      id,
      `billing_${action}`,
      actor,
      new Date(nowSeconds * 1000).toISOString(),
      JSON.stringify({ simulation }),
    ],
  );
}

async function ensure(c: BillingContext, id: string, mode: 'mock' | 'stripe') {
  const effective = await resolveEffectiveEntitlements(c.control, id, c.regions);
  if (effective.legacyExempt || (await isWorkspaceLegacyExempt(c.control, id)))
    fail(409, 'legacy_exempt', 'Imported workspace has no billing');
  await pgRun(
    c.control,
    `INSERT INTO ${c.control.table('workspace_billing')}
      (workspace_id, mode, baseline_tier_id, baseline_revision, applied_generation, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [id, mode, effective.tierId, effective.revision, effective.generation, clock(c)],
  );
  const row = (await load(c, id))!;
  if (row.mode !== mode)
    fail(
      409,
      'billing_mode_conflict',
      'Existing billing must be reconciled before changing provider mode',
    );
  return row;
}

async function locked<T>(
  c: BillingContext,
  id: string,
  action: (leased: BillingContext) => Promise<T>,
): Promise<T> {
  const token = randomId();
  const now = clock(c);
  const acquired = await pgFirst<{ workspace_id: string }>(
    c.control,
    `UPDATE ${c.control.table('workspace_billing')}
     SET lease_token = $1, lease_until = $2
     WHERE workspace_id = $3 AND (lease_until IS NULL OR lease_until <= $4)
     RETURNING workspace_id`,
    [token, now + 180, id, now],
  );
  if (!acquired) fail(409, 'billing_busy', 'Billing operation is in progress; retry shortly');
  const fencedTransaction: Database['transaction'] = (callback) =>
    c.control.transaction(async (tx) => {
      // Match entitlement writers' lock order. Each write checks ownership on its pinned connection.
      await tx.query(`SELECT id FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`, [
        id,
      ]);
      const lease = await pgFirst<{ lease_token: string; lease_until: string | number }>(
        tx,
        `SELECT lease_token, lease_until FROM ${tx.table('workspace_billing')} WHERE workspace_id = $1 FOR UPDATE`,
        [id],
      );
      if (lease?.lease_token !== token || Number(lease.lease_until) <= clock(c))
        fail(409, 'billing_busy', 'Billing lease expired; retry the durable operation');
      return callback(tx);
    });
  const control: Database = {
    schema: c.control.schema,
    table: (name) => c.control.table(name),
    query: (sql, values) =>
      /^\s*SELECT\b/i.test(sql)
        ? c.control.query(sql, values)
        : fencedTransaction((tx) => tx.query(sql, values)),
    transaction: fencedTransaction,
  };
  try {
    return await action({ ...c, control });
  } finally {
    await pgRun(
      c.control,
      `UPDATE ${c.control.table('workspace_billing')}
       SET lease_token = NULL, lease_until = NULL
       WHERE workspace_id = $1 AND lease_token = $2`,
      [id, token],
    );
  }
}

async function publishedSelection(c: BillingContext, tierId: string, revision: number) {
  let catalog = await readProductCatalog(c.control, c.regions, revision);
  if (revision === 0) {
    // Never replace an operator revision that raced the first mock purchase.
    const current = await readProductCatalog(c.control, c.regions);
    const next = {
      ...catalog,
      revision: 1,
      plans: catalog.plans.map((plan) => ({ ...plan, revision: 1 })),
    };
    if (current.revision !== 0 && JSON.stringify(current) !== JSON.stringify(next))
      fail(409, 'catalog_conflict', 'Catalog changed; reload pricing before checkout');
    try {
      catalog =
        current.revision === 1
          ? current
          : await saveProductCatalog(
              c.control,
              c.regions,
              next,
              0,
              'billing',
              'Materialize default contract for checkout',
            );
    } catch {
      const saved = await readProductCatalog(c.control, c.regions, 1);
      if (JSON.stringify(saved) !== JSON.stringify(next))
        fail(409, 'catalog_conflict', 'Catalog changed; reload pricing');
      catalog = saved;
    }
  }
  const plan = catalog.plans.find(
    (plan) => plan.id === tierId && plan.active && plan.published && plan.price.amount > 0,
  );
  if (!plan) fail(400, 'invalid_tier', 'Select an active published paid tier');
  return { catalog, plan };
}

async function preflight(c: BillingContext, row: BillingRow, plan: PlanDefinition) {
  const workspace = await pgFirst<{ state: string }>(
    c.control,
    `SELECT state FROM ${c.control.table('workspaces')} WHERE id = $1`,
    [row.workspace_id],
  );
  if (!workspace || !['active', 'suspended'].includes(workspace.state))
    fail(409, 'capacity_pending', 'Workspace capacity must be provisioned before checkout');
  const effective = await resolveEffectiveEntitlements(c.control, row.workspace_id, c.regions);
  if (effective.generation !== row.applied_generation)
    fail(
      409,
      'operator_assignment',
      'An operator manages this workspace tier; resolve that assignment before purchasing',
    );
  const controls = await pgFirst<{ max_workspaces: number }>(
    c.control,
    `SELECT max_workspaces FROM ${c.control.table('service_controls')} WHERE id = 1`,
  );
  const result = evaluateCapacity(
    { ...plan.entitlements, ...effective.overrides },
    configuredMonitorBatch(c.env),
    null,
    controls?.max_workspaces ?? 10,
  );
  if (!result.safe) fail(409, 'capacity_exceeded', result.warnings.join('; '));
}

export async function getWorkspaceBilling(c: BillingContext, id: string, owner: boolean) {
  const readiness = await billingReadiness(c);
  const effective = await resolveEffectiveEntitlements(c.control, id, c.regions);
  const exempt = effective.legacyExempt || (await isWorkspaceLegacyExempt(c.control, id));
  const row = exempt ? null : await load(c, id);
  const subscriptionPlan =
    row?.tier_id && row.revision !== null
      ? ((await readProductCatalog(c.control, c.regions, row.revision)).plans.find(
          (plan) => plan.id === row.tier_id,
        ) ?? null)
      : null;
  const mockPlan =
    owner &&
    row?.mode === 'mock' &&
    row.checkout_revision !== null &&
    row.checkout_nonce &&
    row.checkout_expires! > clock(c)
      ? ((await readProductCatalog(c.control, c.regions, row.checkout_revision)).plans.find(
          (plan) => plan.id === row.checkout_tier_id,
        ) ?? null)
      : null;
  const active = !!row?.subscription_id && !['canceled', 'incomplete_expired'].includes(row.status);
  let managementUrl: string | null = null;
  try {
    if (!exempt && row?.subscription_id) managementUrl = `${origin(c)}/settings#subscription`;
  } catch {
    /* Readiness describes the missing origin. */
  }
  return {
    ...readiness,
    legacyExempt: exempt,
    subscription: row
      ? {
          status: row.status,
          tierId: row.tier_id,
          revision: row.revision,
          currentPeriodEnd: row.period_end,
          cancelAtPeriodEnd: !!row.cancel_at_period_end,
          graceUntil: row.grace_until,
          pendingReconciliation: !!row.pending,
          activationError: row.activation_error,
          plan: subscriptionPlan,
        }
      : null,
    effectivePlan: { tierId: effective.tierId, revision: effective.revision },
    actions: {
      checkout: owner && !exempt && readiness.ready && !active,
      portal: owner && !exempt && readiness.ready && !!row?.subscription_id,
      cancel: owner && !exempt && readiness.ready && active && !row?.cancel_at_period_end,
      resume: owner && !exempt && readiness.ready && active && !!row?.cancel_at_period_end,
      changePlan: owner && !exempt && readiness.ready && active,
    },
    managementUrl,
    policy: {
      proration: 'Plan changes in Portal may prorate charges; review the amount before confirming.',
      trials: false,
      automaticOverageCharges: false,
      cancellation: 'period_end',
    },
    mockSession:
      owner && row?.mode === 'mock' && row.checkout_nonce && row.checkout_expires! > clock(c)
        ? {
            sessionId: row.checkout_id,
            nonce: row.checkout_nonce,
            expiresAt: row.checkout_expires,
            tierId: row.checkout_tier_id,
            revision: row.checkout_revision,
            plan: mockPlan,
            simulation: true,
          }
        : null,
  };
}

export async function startBillingCheckout(
  c: BillingContext,
  id: string,
  actor: string,
  tierId: string,
  revision: number,
) {
  const selected = await publishedSelection(c, tierId, revision);
  const p = await requireReady(c, selected.catalog);
  if (p.mode === 'disabled') fail(503, 'billing_setup', 'Billing is disabled');
  await ensure(c, id, p.mode);
  return locked(c, id, async (c) => {
    let row = (await load(c, id))!;
    if (row.subscription_id && !['canceled', 'incomplete_expired'].includes(row.status))
      fail(
        409,
        'subscription_exists',
        'Use subscription management to change an existing subscription',
      );
    await preflight(c, row, selected.plan);
    if (row.checkout_operation) {
      if (row.mode === 'stripe' && !row.customer_id && row.checkout_expires! <= clock(c))
        fail(
          409,
          'billing_recovery_required',
          'Customer creation exceeded the Stripe idempotency window; operator reconciliation is required',
        );
      // An unfinished network operation always reuses its key, even after a crash.
      if (!row.checkout_id || row.checkout_expires! > clock(c)) {
        if (row.checkout_tier_id !== tierId || row.checkout_revision !== selected.catalog.revision)
          fail(
            409,
            'checkout_pending',
            'Finish or cancel the pending checkout before choosing another plan',
          );
        if (row.checkout_url) return checkoutDto(c, row);
      } else if (row.mode === 'stripe') {
        const old = await p.getCheckout(row.checkout_id);
        if (!old || old.status !== 'expired')
          fail(
            409,
            'checkout_pending',
            'Previous checkout is awaiting confirmation; retry billing reconciliation',
          );
      }
    }
    const priceId =
      row.mode === 'stripe' ? await validatePrice(c, p, selected.catalog, selected.plan) : '';
    if (!row.checkout_operation || (row.checkout_id && row.checkout_expires! <= clock(c))) {
      await pgRun(
        c.control,
        `UPDATE ${c.control.table('workspace_billing')}
         SET checkout_operation = $1, checkout_tier_id = $2, checkout_revision = $3,
             checkout_id = NULL, checkout_url = NULL, checkout_nonce = $4, checkout_expires = $5, updated_at = $6
         WHERE workspace_id = $7`,
        [
          randomId(),
          tierId,
          selected.catalog.revision,
          row.mode === 'mock' ? randomToken() : null,
          clock(c) + (row.mode === 'mock' ? 1800 : 86400),
          clock(c),
          id,
        ],
      );
      row = (await load(c, id))!;
    }
    if (row.mode === 'mock') {
      const session = `mock_cs_${row.checkout_operation!.replaceAll('-', '')}`;
      const url = `${origin(c)}/mock-billing/checkout?session_id=${encodeURIComponent(session)}`;
      await c.control.transaction(async (tx) => {
        await pgRun(
          tx,
          `UPDATE ${tx.table('workspace_billing')} SET checkout_id = $1, checkout_url = $2 WHERE workspace_id = $3`,
          [session, url, id],
        );
        await audit(tx, id, actor, 'checkout_started', true, clock(c));
      });
    } else {
      if (!row.customer_id) {
        const customer = await p.createCustomer({
          workspaceId: id,
          idempotencyKey: `billing:customer:${id}`,
          metadata: { mode: 'stripe', planId: tierId, revision: String(selected.catalog.revision) },
        });
        if (customer.livemode !== live(c) || customer.metadata.workspaceId !== id)
          fail(502, 'billing_identity', 'Stripe customer identity could not be verified');
        await pgRun(
          c.control,
          `UPDATE ${c.control.table('workspace_billing')} SET customer_id = $1 WHERE workspace_id = $2`,
          [customer.id, id],
        );
        row = (await load(c, id))!;
      }
      const session = await p.createSubscriptionCheckout({
        customerId: row.customer_id!,
        priceId,
        clientReferenceId: id,
        workspaceId: id,
        planId: tierId,
        revision: selected.catalog.revision,
        idempotencyKey: `billing:checkout:${row.checkout_operation}`,
        expiresAt: row.checkout_expires!,
        successUrl: `${origin(c)}/settings?billing=returned#subscription`,
        cancelUrl: `${origin(c)}/settings?billing=cancelled#subscription`,
      });
      if (
        session.customerId !== row.customer_id ||
        session.clientReferenceId !== id ||
        !session.url
      )
        fail(502, 'billing_identity', 'Checkout identity could not be verified');
      await c.control.transaction(async (tx) => {
        await pgRun(
          tx,
          `UPDATE ${tx.table('workspace_billing')} SET checkout_id = $1, checkout_url = $2 WHERE workspace_id = $3`,
          [session.id, session.url, id],
        );
        await audit(tx, id, actor, 'checkout_started', false, clock(c));
      });
    }
    return checkoutDto(c, (await load(c, id))!);
  });
}

async function checkoutDto(c: BillingContext, row: BillingRow) {
  const catalog = await readProductCatalog(c.control, c.regions, row.checkout_revision!);
  const plan = catalog.plans.find((plan) => plan.id === row.checkout_tier_id)!;
  return {
    mode: row.mode,
    simulation: row.mode === 'mock',
    url: row.checkout_url,
    sessionId: row.checkout_id,
    expiresAt: row.checkout_expires,
    tierId: row.checkout_tier_id,
    revision: row.checkout_revision,
    plan,
    ...(row.mode === 'mock' ? { nonce: row.checkout_nonce } : {}),
  };
}

function graceSeconds(c: BillingContext) {
  const days = Number(setting(c, 'BILLING_GRACE_DAYS') || 7);
  if (!Number.isInteger(days) || days < 0 || days > 30)
    fail(503, 'billing_setup', 'BILLING_GRACE_DAYS must be an integer from 0 to 30');
  return days * 86400;
}

async function resolveMappedPlan(c: BillingContext, row: BillingRow, sub: StripeSubscription) {
  if (
    sub.items?.length !== 1 ||
    sub.items[0]!.quantity !== 1 ||
    sub.priceIds.length !== 1 ||
    sub.items[0]!.priceId !== sub.priceIds[0]
  )
    fail(
      422,
      'billing_price',
      'Subscription must have exactly one licensed plan with quantity one',
    );
  const revisions = await pgAll<{ revision: number }>(
    c.control,
    `SELECT revision FROM ${c.control.table('product_catalog_revisions')} r
    WHERE jsonb_typeof(r.catalog::jsonb->'stripePriceIds') = 'object'
      AND EXISTS (
        SELECT 1 FROM jsonb_each_text(r.catalog::jsonb->'stripePriceIds') p
        WHERE p.value = $1
      )
    ORDER BY revision DESC LIMIT 100`,
    [sub.priceIds[0]],
  );
  // Initial and replacement purchases pin the checkout contract. Existing Prices retain theirs.
  const pinnedRevision = row.subscription_id !== sub.id ? row.checkout_revision : row.revision;
  if (pinnedRevision) {
    // The pinned revision may be older than the bounded catalog search.
    revisions.unshift({ revision: pinnedRevision });
  }
  for (const item of revisions) {
    const catalog = await readProductCatalog(c.control, c.regions, item.revision);
    if (catalog.billingMode !== 'stripe' || catalog.preview) continue;
    const plan = catalog.plans.find(
      (plan) =>
        plan.active &&
        plan.published &&
        !plan.preview &&
        plan.price.amount > 0 &&
        catalog.stripePriceIds?.[plan.id] === sub.priceIds[0],
    );
    if (plan) {
      await validatePrice(c, provider(c, 'stripe', catalog), catalog, plan);
      return { tierId: plan.id, revision: catalog.revision };
    }
  }
  fail(422, 'billing_price', 'Subscription Price has no approved immutable contract');
}

async function canonical(c: BillingContext, row: BillingRow, subscriptionId: string) {
  const catalog = await readProductCatalog(c.control, c.regions);
  const sub = await provider(c, 'stripe', catalog).getSubscription(subscriptionId);
  if (!sub)
    fail(503, 'billing_provider', 'Canonical subscription is unavailable; retry reconciliation');
  if (sub.customerId !== row.customer_id || sub.livemode !== live(c))
    fail(422, 'billing_identity', 'Subscription customer or mode mismatch');
  // Existing subscriptions remain recognizable when Stripe omits metadata. Metadata never relocates them.
  if (sub.metadata.workspaceId && sub.metadata.workspaceId !== row.workspace_id)
    fail(422, 'billing_identity', 'Subscription workspace mismatch');
  if (sub.metadata.mode && sub.metadata.mode !== 'stripe')
    fail(422, 'billing_identity', 'Subscription billing mode mismatch');
  if (!row.subscription_id || row.subscription_id !== sub.id) {
    if (!row.checkout_id || !row.checkout_operation)
      fail(422, 'billing_identity', 'Subscription has no server checkout');
    const checkout = await provider(c, 'stripe', catalog).getCheckout(row.checkout_id);
    if (
      !checkout ||
      checkout.customerId !== row.customer_id ||
      checkout.subscriptionId !== sub.id ||
      checkout.clientReferenceId !== row.workspace_id ||
      checkout.metadata.planId !== row.checkout_tier_id ||
      checkout.metadata.revision !== String(row.checkout_revision)
    )
      fail(422, 'billing_identity', 'Subscription does not match the pending server checkout');
    if (row.subscription_id && !['canceled', 'incomplete_expired'].includes(row.status))
      fail(422, 'billing_identity', 'A different subscription is already active');
    const selected = await readProductCatalog(c.control, c.regions, row.checkout_revision!);
    if (
      sub.priceIds.length !== 1 ||
      sub.priceIds[0] !== selected.stripePriceIds?.[row.checkout_tier_id!]
    )
      fail(
        422,
        'billing_price',
        'Initial subscription Price differs from the server checkout contract',
      );
  }
  const plan = await resolveMappedPlan(c, row, sub);
  // Incomplete/unpaid checkout cannot grant an active-looking arbitrary subscription.
  if (!row.subscription_id || row.subscription_id !== sub.id || row.status === 'incomplete') {
    const checkout = await provider(c, 'stripe', catalog).getCheckout(row.checkout_id!);
    if (
      !checkout ||
      !['paid', 'no_payment_required'].includes(checkout.paymentStatus ?? '') ||
      checkout.status !== 'complete'
    )
      return { ...sub, status: 'incomplete' as const, ...plan };
  }
  return { ...sub, ...plan };
}

async function persistCanonical(
  c: BillingContext,
  row: BillingRow,
  sub: StripeSubscription & { tierId: string; revision: number },
) {
  const grace = sub.status === 'past_due' ? (row.grace_until ?? clock(c) + graceSeconds(c)) : null;
  const now = clock(c);
  await pgRun(
    c.control,
    `UPDATE ${c.control.table('workspace_billing')}
     SET subscription_id = $1, status = $2, tier_id = $3, revision = $4, period_end = $5,
         cancel_at_period_end = $6, grace_until = $7, pending = 1, due_at = $8, updated_at = $9
     WHERE workspace_id = $10`,
    [
      sub.id,
      sub.status,
      sub.tierId,
      sub.revision,
      sub.periodEnd,
      sub.cancelAtPeriodEnd ? 1 : 0,
      grace,
      now,
      now,
      row.workspace_id,
    ],
  );
}

async function applyLifecycle(c: BillingContext, row: BillingRow) {
  const now = clock(c);
  if (
    row.mode === 'mock' &&
    row.cancel_at_period_end &&
    row.period_end !== null &&
    row.period_end <= now
  ) {
    await pgRun(
      c.control,
      `UPDATE ${c.control.table('workspace_billing')} SET status = 'canceled' WHERE workspace_id = $1`,
      [row.workspace_id],
    );
    row = { ...row, status: 'canceled' };
  }
  const entitled =
    ['active', 'trialing'].includes(row.status) &&
    !(row.cancel_at_period_end && row.period_end !== null && row.period_end <= now);
  const grace = row.status === 'past_due' && row.grace_until !== null && row.grace_until > now;
  const target = entitled
    ? { tierId: row.tier_id!, revision: row.revision! }
    : grace
      ? null
      : { tierId: row.baseline_tier_id, revision: row.baseline_revision };
  const effective = await resolveEffectiveEntitlements(c.control, row.workspace_id, c.regions);
  if (effective.generation !== row.applied_generation) {
    await pgRun(
      c.control,
      `UPDATE ${c.control.table('workspace_billing')}
       SET pending = 1, activation_error = 'operator_assignment', due_at = $1
       WHERE workspace_id = $2`,
      [now + 60, row.workspace_id],
    );
    return false;
  }
  if (target && (effective.tierId !== target.tierId || effective.revision !== target.revision)) {
    try {
      const assigned = await applyWorkspaceTier(c.control, {
        workspaceId: row.workspace_id,
        ...target,
        expectedGeneration: effective.generation,
        actor: 'billing',
        reason: `Billing lifecycle: ${row.status}`,
        configuredRegionIds: c.regions,
        monitorBatch: configuredMonitorBatch(c.env),
        restoreDefaultFree: target.revision === 0,
        billingTransition: true,
        billingFallback: !entitled && !grace,
      });
      if (assigned.generation !== effective.generation + 1) throw new Error('billing_generation');
    } catch (error) {
      if (!(error instanceof ProductTierError) || error.status !== 409) throw error;
      await pgRun(
        c.control,
        `UPDATE ${c.control.table('workspace_billing')}
         SET pending = 1, activation_error = $1, due_at = $2
         WHERE workspace_id = $3`,
        [error.code, now + 60, row.workspace_id],
      );
      return false;
    }
  }
  const deadline = grace
    ? row.grace_until
    : entitled && row.cancel_at_period_end
      ? row.period_end
      : null;
  const due =
    row.mode === 'stripe' && row.subscription_id
      ? Math.min(deadline ?? now + 3600, now + 3600)
      : deadline;
  await pgRun(
    c.control,
    `UPDATE ${c.control.table('workspace_billing')}
     SET pending = 0, activation_error = NULL, due_at = $1, updated_at = $2
     WHERE workspace_id = $3`,
    [due, now, row.workspace_id],
  );
  return true;
}

export async function confirmMockBilling(
  c: BillingContext,
  id: string,
  actor: string,
  sessionId: string,
  nonce: string,
  outcome: 'purchase' | 'cancel' | 'payment_failed' = 'purchase',
) {
  const catalog = await readProductCatalog(c.control, c.regions);
  const p = await requireReady(c, catalog);
  if (p.mode !== 'mock') fail(404, 'not_found', 'Billing simulation is unavailable');
  return locked(c, id, async (c) => {
    const row = (await load(c, id))!;
    if (
      row.mode !== 'mock' ||
      !row.checkout_nonce ||
      row.checkout_nonce !== nonce ||
      row.checkout_id !== sessionId
    )
      fail(409, 'mock_session_used', 'Simulation session is invalid or already used');
    if (!row.checkout_expires || row.checkout_expires <= clock(c))
      fail(410, 'mock_session_expired', 'Simulation session has expired');
    const subscription = `mock_sub_${row.checkout_operation!.replaceAll('-', '')}`;
    await c.control.transaction(async (tx) => {
      // Consume nonce and durable simulated state in one statement via CAS RETURNING workspace_id
      const updateResult = await tx.query(
        `UPDATE ${tx.table('workspace_billing')}
       SET checkout_nonce = NULL, checkout_url = NULL, checkout_operation = NULL,
           subscription_id = CASE WHEN $1 = 'cancel' THEN subscription_id WHEN $2 = 'payment_failed' THEN NULL ELSE $3 END,
           status = CASE WHEN $4 = 'cancel' THEN status WHEN $5 = 'payment_failed' THEN 'none' ELSE 'active' END,
           tier_id = CASE WHEN $6 = 'cancel' THEN tier_id ELSE checkout_tier_id END,
           revision = CASE WHEN $7 = 'cancel' THEN revision ELSE checkout_revision END,
           period_end = CASE WHEN $8 = 'cancel' THEN period_end ELSE $9 END,
           cancel_at_period_end = CASE WHEN $10 = 'cancel' THEN cancel_at_period_end ELSE 0 END,
           grace_until = CASE WHEN $11 = 'cancel' THEN grace_until ELSE NULL END,
           pending = 1, due_at = $12
       WHERE workspace_id = $13 AND checkout_nonce = $14
       RETURNING workspace_id`,
        [
          outcome,
          outcome,
          subscription,
          outcome,
          outcome,
          outcome,
          outcome,
          outcome,
          clock(c) + 30 * 86400,
          outcome,
          outcome,
          clock(c),
          id,
          nonce,
        ],
      );
      if (updateResult.rowCount !== 1) {
        fail(409, 'mock_session_used', 'Simulation session is invalid or already used');
      }
      await audit(tx, id, actor, `mock_${outcome}`, true, clock(c));
    });
    await applyLifecycle(c, (await load(c, id))!);
    return getWorkspaceBilling(c, id, true);
  });
}

export async function manageBilling(
  c: BillingContext,
  id: string,
  actor: string,
  action: 'portal' | 'cancel' | 'resume' | 'payment_failed',
) {
  const catalog = await readProductCatalog(c.control, c.regions);
  const p = await requireReady(c, catalog);
  const existing = await load(c, id);
  if (!existing?.subscription_id) fail(409, 'subscription_missing', 'No subscription to manage');
  if (existing.mode !== p.mode)
    fail(409, 'billing_mode_conflict', 'Existing billing mode differs from deployment');
  return locked(c, id, async (c) => {
    let row = (await load(c, id))!;
    if (action === 'portal') {
      if (row.mode === 'mock')
        return { mode: 'mock', simulation: true, url: `${origin(c)}/settings#subscription` };
      const portal = await p.createPortalSession({
        customerId: row.customer_id!,
        returnUrl: `${origin(c)}/settings#subscription`,
        idempotencyKey: `billing:portal:${id}:${Math.floor(clock(c) / 300)}`,
        configurationId: setting(c, 'STRIPE_PORTAL_CONFIGURATION_ID'),
      });
      await audit(c.control, id, actor, 'portal', false, clock(c));
      return { mode: 'stripe', simulation: false, url: portal.url };
    }
    if (action === 'payment_failed' && row.mode !== 'mock')
      fail(404, 'not_found', 'Simulation is unavailable');
    if (['canceled', 'unpaid', 'incomplete_expired', 'incomplete'].includes(row.status))
      fail(409, 'subscription_terminal', 'Subscription cannot be changed in its current state');
    if (row.action_operation && row.action_kind !== action)
      fail(409, 'billing_pending', 'Retry the pending billing action first');
    if (!row.action_operation) {
      await pgRun(
        c.control,
        `UPDATE ${c.control.table('workspace_billing')}
         SET action_operation = $1, action_kind = $2, pending = 1, due_at = $3
         WHERE workspace_id = $4`,
        [randomId(), action, clock(c), id],
      );
      row = (await load(c, id))!;
    }
    if (row.mode === 'mock') {
      await pgRun(
        c.control,
        `UPDATE ${c.control.table('workspace_billing')}
         SET cancel_at_period_end = $1, status = $2, grace_until = $3, pending = 1, due_at = $4
         WHERE workspace_id = $5`,
        [
          action === 'cancel' ? 1 : 0,
          action === 'payment_failed' ? 'past_due' : 'active',
          action === 'payment_failed' ? (row.grace_until ?? clock(c) + graceSeconds(c)) : null,
          clock(c),
          id,
        ],
      );
    } else {
      const key = `billing:${action}:${row.action_operation}`;
      if (action === 'cancel') await p.scheduleSubscriptionCancel(row.subscription_id!, key);
      else await p.resumeSubscription(row.subscription_id!, key);
      await persistCanonical(c, row, await canonical(c, row, row.subscription_id!));
    }
    await applyLifecycle(c, (await load(c, id))!);
    await c.control.transaction(async (tx) => {
      await audit(tx, id, actor, action, row.mode === 'mock', clock(c));
      await pgRun(
        tx,
        `UPDATE ${tx.table('workspace_billing')} SET action_operation = NULL, action_kind = NULL WHERE workspace_id = $1`,
        [id],
      );
    });
    return getWorkspaceBilling(c, id, true);
  });
}

export async function changeMockBillingPlan(
  c: BillingContext,
  id: string,
  actor: string,
  tierId: string,
  revision: number,
) {
  const selected = await publishedSelection(c, tierId, revision);
  const p = await requireReady(c, selected.catalog);
  if (p.mode !== 'mock') fail(404, 'not_found', 'Real subscription plan changes use Portal');
  return locked(c, id, async (c) => {
    const row = (await load(c, id))!;
    if (
      row.mode !== 'mock' ||
      !row.subscription_id ||
      !['active', 'trialing', 'past_due'].includes(row.status)
    )
      fail(409, 'subscription_missing', 'No simulated subscription to change');
    await preflight(c, row, selected.plan);
    await pgRun(
      c.control,
      `UPDATE ${c.control.table('workspace_billing')} SET tier_id = $1, revision = $2, pending = 1, due_at = $3 WHERE workspace_id = $4`,
      [tierId, selected.catalog.revision, clock(c), id],
    );
    await applyLifecycle(c, (await load(c, id))!);
    await audit(c.control, id, actor, 'mock_plan_changed', true, clock(c));
    return getWorkspaceBilling(c, id, true);
  });
}

const handledEvents = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

function objectId(value: unknown) {
  return typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
      ? value.id
      : null;
}

async function boundedWebhookBody(request: Request) {
  const max = 65536;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > max)
    fail(413, 'body_too_large', 'Webhook exceeds 64 KiB');
  if (!request.body) fail(400, 'invalid_webhook', 'Webhook body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) {
        await reader.cancel();
        fail(413, 'body_too_large', 'Webhook exceeds 64 KiB');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(400, 'invalid_webhook', 'Webhook body must be UTF-8');
  }
}

export async function billingWebhook(c: BillingContext, request: Request) {
  const raw = await boundedWebhookBody(request);
  const catalog = await readProductCatalog(c.control, c.regions);
  // Catalog preview can be restored by an operator; existing real contracts still reconcile.
  if (setting(c, 'BILLING_MODE') !== 'stripe' || !setting(c, 'STRIPE_WEBHOOK_SECRET'))
    fail(503, 'billing_setup', 'Stripe webhook is not configured');
  let event;
  try {
    event = await provider(c, 'stripe', catalog).verifyWebhook(
      raw,
      request.headers.get('stripe-signature') ?? '',
    );
  } catch (error) {
    if (error instanceof StripeSignatureVerificationError || error instanceof StripeValidationError)
      fail(400, 'invalid_webhook', 'Webhook signature or envelope is invalid');
    throw error;
  }
  if (
    event.livemode !== live(c) ||
    ((event.account || setting(c, 'STRIPE_ACCOUNT_ID')) &&
      event.account !== setting(c, 'STRIPE_ACCOUNT_ID'))
  )
    fail(400, 'invalid_webhook', 'Webhook account or mode mismatch');
  if (!handledEvents.has(event.type)) return json({ received: true });
  const object = event.data.object;
  const invoiceParent =
    object.parent && typeof object.parent === 'object' && 'subscription_details' in object.parent
      ? object.parent.subscription_details
      : null;
  const subscriptionId = event.type.startsWith('customer.subscription.')
    ? objectId(object.id)
    : (objectId(object.subscription) ??
      (invoiceParent && typeof invoiceParent === 'object' && 'subscription' in invoiceParent
        ? objectId(invoiceParent.subscription)
        : null));
  const customerId = objectId(object.customer);
  if (!subscriptionId || !customerId)
    fail(400, 'invalid_webhook', 'Event lacks subscription/customer identity');
  const existing = await loadBySubscriptionId(c, subscriptionId);
  const row = existing ?? (await loadByCustomerId(c, customerId));
  // Other Stripe customers are outside this application. No metadata-based lookup or customer move.
  if (!row) return json({ received: true });
  if (row.mode !== 'stripe' || row.customer_id !== customerId)
    fail(400, 'billing_identity', 'Webhook customer mismatch');
  const inserted = await pgFirst<{ event_id: string }>(
    c.control,
    `INSERT INTO ${c.control.table('billing_webhook_events')}
      (event_id, workspace_id, subscription_id, event_type, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.id, row.workspace_id, subscriptionId, event.type, clock(c)],
  );
  if (!inserted) {
    const prior = await pgFirst<{ state: string; workspace_id: string; subscription_id: string }>(
      c.control,
      `SELECT state, workspace_id, subscription_id FROM ${c.control.table('billing_webhook_events')} WHERE event_id = $1`,
      [event.id],
    );
    if (prior?.workspace_id !== row.workspace_id || prior?.subscription_id !== subscriptionId)
      fail(400, 'billing_identity', 'Event identity changed');
    if (prior?.state === 'completed') return json({ received: true });
  }
  try {
    await locked(c, row.workspace_id, async (c) => {
      const fresh = (await load(c, row.workspace_id))!;
      const claimResult = await c.control.query(
        `UPDATE ${c.control.table('billing_webhook_events')}
         SET state = 'processing', lease_until = $1
         WHERE event_id = $2 AND state <> 'completed'
         RETURNING event_id`,
        [clock(c) + 180, event.id],
      );
      if (claimResult.rowCount === 0) {
        return;
      }
      // Old subscription events never revoke a replacement, even when metadata is stale.
      if (
        fresh.subscription_id &&
        fresh.subscription_id !== subscriptionId &&
        !fresh.checkout_operation
      ) {
        await pgRun(
          c.control,
          `UPDATE ${c.control.table('billing_webhook_events')}
           SET state = 'completed', lease_until = NULL, completed_at = $1
           WHERE event_id = $2`,
          [clock(c), event.id],
        );
        return;
      }
      const sub = await canonical(c, fresh, subscriptionId);
      await persistCanonical(c, fresh, sub);
      const applied = await applyLifecycle(c, (await load(c, row.workspace_id))!);
      if (!applied)
        fail(
          503,
          'billing_reconciliation_pending',
          'Payment recorded; entitlement reconciliation will retry',
        );
      await pgBatch(c.control, [
        {
          sql: `UPDATE ${c.control.table('billing_webhook_events')} SET state = 'completed', lease_until = NULL, completed_at = $1 WHERE event_id = $2`,
          values: [clock(c), event.id],
        },
        {
          sql: `UPDATE ${c.control.table('workspace_billing')} SET checkout_operation = NULL, checkout_url = NULL WHERE workspace_id = $1 AND status <> 'incomplete'`,
          values: [row.workspace_id],
        },
      ]);
    });
  } catch (error) {
    await pgRun(
      c.control,
      `UPDATE ${c.control.table('billing_webhook_events')}
       SET state = 'pending', lease_until = NULL
       WHERE event_id = $1 AND state <> 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM ${c.control.table('workspace_billing')} wb
           WHERE wb.workspace_id = $2 AND wb.lease_until > $3
         )`,
      [event.id, row.workspace_id, clock(c)],
    );
    // Invalid signed identities also retry, preserving known-good entitlements for operator repair.
    if (error instanceof HttpErrorLike)
      fail(
        503,
        'billing_reconciliation_pending',
        'Billing reconciliation failed; retry after configuration or lease recovery',
      );
    throw error;
  }
  return json({ received: true });
}

/** Root scheduler calls this bounded hook. It repairs pending events and enforces grace/period deadlines. */
export async function reconcileDueBilling(c: BillingContext, limit = 10) {
  const now = clock(c);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 10;
  const rawRows = await pgAll<RawBillingRow>(
    c.control,
    `SELECT wb.* FROM ${c.control.table('workspace_billing')} wb
     WHERE wb.due_at <= $1 OR wb.action_operation IS NOT NULL OR EXISTS (
       SELECT 1 FROM ${c.control.table('billing_webhook_events')} e
       WHERE e.workspace_id = wb.workspace_id
         AND e.state <> 'completed'
         AND (e.lease_until IS NULL OR e.lease_until <= $2)
     )
     ORDER BY COALESCE(wb.due_at, 0), wb.workspace_id
     LIMIT $3`,
    [now, now, boundedLimit],
  );
  const rows = rawRows.map(mapBillingRow).filter((r): r is BillingRow => r !== null);
  let reconciled = 0;
  for (const candidate of rows) {
    try {
      await locked(c, candidate.workspace_id, async (c) => {
        let row = (await load(c, candidate.workspace_id))!;
        if (row.action_operation && row.mode === 'stripe') {
          const catalog = await readProductCatalog(c.control, c.regions);
          const p = provider(c, 'stripe', catalog);
          const key = `billing:${row.action_kind}:${row.action_operation}`;
          if (row.action_kind === 'cancel')
            await p.scheduleSubscriptionCancel(row.subscription_id!, key);
          else if (row.action_kind === 'resume')
            await p.resumeSubscription(row.subscription_id!, key);
          await pgRun(
            c.control,
            `UPDATE ${c.control.table('workspace_billing')} SET action_operation = NULL, action_kind = NULL WHERE workspace_id = $1`,
            [row.workspace_id],
          );
        }
        const events = await pgAll<{ subscription_id: string }>(
          c.control,
          `SELECT DISTINCT subscription_id FROM ${c.control.table('billing_webhook_events')}
           WHERE workspace_id = $1 AND state <> 'completed'
           LIMIT 10`,
          [row.workspace_id],
        );
        const replacement =
          row.checkout_operation &&
          (!row.subscription_id || ['canceled', 'incomplete_expired'].includes(row.status))
            ? events.find((event) => event.subscription_id !== row.subscription_id)?.subscription_id
            : null;
        const subscriptionId = replacement ?? row.subscription_id ?? events[0]?.subscription_id;
        let verified = true;
        if (row.mode === 'stripe' && subscriptionId) {
          // Network failure never erases a contract. Known deadlines below remain enforceable.
          try {
            await persistCanonical(c, row, await canonical(c, row, subscriptionId));
          } catch {
            if (
              !(row.grace_until !== null && row.grace_until <= clock(c)) &&
              !(row.cancel_at_period_end && row.period_end !== null && row.period_end <= clock(c))
            )
              throw new Error('billing_provider_pending');
            verified = false;
          }
          row = (await load(c, row.workspace_id))!;
        }
        if (await applyLifecycle(c, row)) {
          if (row.mode === 'mock' && row.action_operation)
            await pgRun(
              c.control,
              `UPDATE ${c.control.table('workspace_billing')} SET action_operation = NULL, action_kind = NULL WHERE workspace_id = $1`,
              [row.workspace_id],
            );
          if (verified) {
            await pgRun(
              c.control,
              `UPDATE ${c.control.table('billing_webhook_events')}
               SET state = 'completed', lease_until = NULL, completed_at = $1
               WHERE workspace_id = $2 AND state <> 'completed' AND subscription_id = $3`,
              [clock(c), row.workspace_id, subscriptionId],
            );
            if (row.status !== 'incomplete') {
              await pgBatch(c.control, [
                {
                  sql: `UPDATE ${c.control.table('workspace_billing')} SET checkout_operation = NULL, checkout_url = NULL WHERE workspace_id = $1`,
                  values: [row.workspace_id],
                },
                {
                  sql: `UPDATE ${c.control.table('billing_webhook_events')} SET state = 'completed', lease_until = NULL, completed_at = $1 WHERE workspace_id = $2 AND state <> 'completed' AND subscription_id <> $3`,
                  values: [clock(c), row.workspace_id, subscriptionId],
                },
              ]);
            }
          } else
            await pgRun(
              c.control,
              `UPDATE ${c.control.table('workspace_billing')} SET pending = 1, due_at = $1 WHERE workspace_id = $2`,
              [clock(c) + 60, row.workspace_id],
            );
          reconciled++;
        }
      });
    } catch {
      await pgRun(
        c.control,
        `UPDATE ${c.control.table('workspace_billing')} SET pending = 1, due_at = $1
         WHERE workspace_id = $2 AND (lease_until IS NULL OR lease_until <= $3)`,
        [clock(c) + 60, candidate.workspace_id, clock(c)],
      );
    }
  }
  return { scanned: rows.length, reconciled };
}

export async function workspaceBillingRequest(
  c: BillingContext,
  request: Request,
  workspace: { id: string; role?: string },
  actor: string,
) {
  const path = new URL(request.url).pathname;
  if (path === '/api/workspace/billing' && request.method === 'GET')
    return json(await getWorkspaceBilling(c, workspace.id, workspace.role === 'owner'));
  if (request.method !== 'POST') fail(405, 'method_not_allowed', 'Billing actions require POST');
  if (workspace.role !== 'owner') fail(403, 'forbidden', 'Workspace owner access required');
  if (await isWorkspaceLegacyExempt(c.control, workspace.id))
    fail(409, 'legacy_exempt', 'Imported workspace has no billing');
  const body = (await readJson(request)) as Record<string, unknown>;
  if (path === '/api/workspace/billing/mock/change-plan') {
    if (
      !body ||
      typeof body.tierId !== 'string' ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 0
    )
      fail(400, 'invalid_plan', 'Provide tierId and immutable revision');
    return json(
      await changeMockBillingPlan(c, workspace.id, actor, body.tierId, body.revision as number),
    );
  }
  if (path === '/api/workspace/billing/checkout') {
    if (
      !body ||
      typeof body.tierId !== 'string' ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 0
    )
      fail(400, 'invalid_plan', 'Provide tierId and immutable revision');
    return json(
      await startBillingCheckout(c, workspace.id, actor, body.tierId, body.revision as number),
    );
  }
  if (
    path === '/api/workspace/billing/mock/confirm' ||
    path === '/api/workspace/billing/mock/cancel'
  ) {
    if (!body || typeof body.sessionId !== 'string' || typeof body.nonce !== 'string')
      fail(400, 'invalid_mock_session', 'Provide sessionId and one-time nonce');
    return json(
      await confirmMockBilling(
        c,
        workspace.id,
        actor,
        body.sessionId,
        body.nonce,
        path.endsWith('/cancel')
          ? 'cancel'
          : body.outcome === 'payment_failed'
            ? 'payment_failed'
            : 'purchase',
      ),
    );
  }
  if (path === '/api/workspace/billing/mock/payment-failed')
    return json(await manageBilling(c, workspace.id, actor, 'payment_failed'));
  const action = path.split('/').at(-1);
  if (action === 'portal' || action === 'cancel' || action === 'resume')
    return json(await manageBilling(c, workspace.id, actor, action));
  fail(404, 'not_found', 'Billing endpoint not found');
}
