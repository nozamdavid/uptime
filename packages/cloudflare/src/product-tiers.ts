import { randomId } from './crypto.js';
import { evaluateCapacity, configuredMonitorBatch } from './capacity.js';
import { defaultProductLimits, savedWorkspaceProductLimits } from './product-limits.js';
import { regionIds, type RegionId } from './regions.js';
import type { Database } from './postgres/database.js';
import { isPostgresUniqueViolation } from './postgres/database.js';
import { pgAll, pgFirst, pgRun } from './postgres/query.js';
import defaultCatalogConfig from '../../../config/product-tiers.json' with { type: 'json' };

export interface TierEntitlements {
  monitors: number;
  regions: number;
  allowedRegionIds: RegionId[];
  seats: number;
  statusPages: number;
  notificationDestinations: number;
  customDomains: number;
  intervalSeconds: 300;
  rawRetentionHours: 24;
  dailyRetentionDays: 30;
}

export interface PlanDefinition {
  id: string;
  revision: number;
  name: string;
  description: string;
  price: { amount: number; currency: 'usd' | 'eur'; interval: 'month' };
  entitlements: TierEntitlements;
  features: string[];
  active: boolean;
  published: boolean;
  preview: boolean;
}

export interface ProductCatalog {
  revision: number;
  preview: boolean;
  billingMode: 'disabled' | 'mock' | 'stripe';
  plans: PlanDefinition[];
  /** Private, secret-free mappings. Never included in public responses. */
  stripePriceIds?: Record<string, string>;
}

export class ProductTierError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new ProductTierError(400, 'invalid_catalog', message);
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    invalid(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`Invalid ${field}`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be boolean`);
  return value;
}

export function tierFeatures(e: TierEntitlements): string[] {
  return [
    `${e.monitors} monitors`,
    `${e.regions} regions per monitor`,
    `${e.seats} workspace seats`,
    `${e.statusPages} status pages`,
    `${e.notificationDestinations} notification destinations`,
    `${e.customDomains} custom status domains (preview)`,
    'Five-minute checks',
    '24-hour detailed history',
    '30-day daily uptime',
    'Telegram and Discord',
  ];
}

/** Validate the whole persisted snapshot. Corrupt configuration must fail closed. */
export function validateProductCatalog(
  value: unknown,
  configured: readonly RegionId[],
): ProductCatalog {
  const input = object(value);
  const revision = integer(input.revision, 0, 1_000_000_000, 'revision');
  const preview = boolean(input.preview, 'preview');
  if (!['disabled', 'mock', 'stripe'].includes(String(input.billingMode)))
    invalid('Billing mode must be disabled, mock or stripe');
  if (!Array.isArray(input.plans) || input.plans.length < 1 || input.plans.length > 50)
    invalid('Invalid plans');
  const ids = new Set<string>();
  const plans = input.plans.map((value): PlanDefinition => {
    const plan = object(value);
    const id = string(plan.id, 'tier ID', 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || ids.has(id)) invalid('Duplicate or invalid tier ID');
    ids.add(id);
    if (plan.revision !== revision) invalid('Plan revision must match catalog revision');
    const price = object(plan.price);
    if (!['usd', 'eur'].includes(String(price.currency)) || price.interval !== 'month')
      invalid('Only monthly USD or EUR prices are supported');
    const e = object(plan.entitlements);
    const allowed = e.allowedRegionIds;
    if (
      !Array.isArray(allowed) ||
      allowed.length < 1 ||
      allowed.length > 9 ||
      allowed.some((id) => !configured.includes(id)) ||
      new Set(allowed).size !== allowed.length
    )
      invalid('Region grants must use distinct deployed regions');
    if (e.intervalSeconds !== 300 || e.rawRetentionHours !== 24 || e.dailyRetentionDays !== 30)
      invalid('All tiers require 300-second checks, 24-hour raw history and 30-day daily uptime');
    const entitlements: TierEntitlements = {
      monitors: integer(e.monitors, 0, 1000, 'monitors'),
      regions: integer(e.regions, 1, allowed.length, 'regions'),
      allowedRegionIds: allowed as RegionId[],
      seats: integer(e.seats, 1, 1000, 'seats'),
      statusPages: integer(e.statusPages, 0, 1000, 'statusPages'),
      notificationDestinations: integer(
        e.notificationDestinations,
        0,
        1000,
        'notificationDestinations',
      ),
      customDomains: integer(e.customDomains, 0, 1000, 'customDomains'),
      intervalSeconds: 300,
      rawRetentionHours: 24,
      dailyRetentionDays: 30,
    };
    if (entitlements.customDomains > entitlements.statusPages)
      invalid('At most one custom domain per page');
    if (!evaluateCapacity(entitlements).safe) invalid('Tier exceeds scheduler capacity');
    const planPreview = boolean(plan.preview, 'plan.preview');
    return {
      id,
      revision,
      name: string(plan.name, 'name', 100),
      description: string(plan.description, 'description', 1000),
      price: {
        amount: integer(price.amount, 0, 100_000_000, 'price.amount'),
        currency: price.currency as 'usd' | 'eur',
        interval: 'month',
      },
      entitlements,
      features: tierFeatures(entitlements),
      active: boolean(plan.active, 'active'),
      published: boolean(plan.published, 'published'),
      preview: planPreview,
    };
  });
  if (!plans.some((plan) => plan.id === 'free' && plan.active && plan.price.amount === 0))
    invalid('An active zero-price free tier is required');
  const catalog: ProductCatalog = {
    revision,
    preview,
    billingMode: input.billingMode as ProductCatalog['billingMode'],
    plans,
  };
  if (input.stripePriceIds !== undefined) {
    const mappings = object(input.stripePriceIds);
    const stripePriceIds: Record<string, string> = {};
    for (const [id, value] of Object.entries(mappings)) {
      if (!ids.has(id) || typeof value !== 'string' || !/^price_[A-Za-z0-9]{1,200}$/.test(value))
        invalid('Invalid Stripe price mapping');
      stripePriceIds[id] = value;
    }
    catalog.stripePriceIds = stripePriceIds;
  }
  return catalog;
}

/** The bundled config supplies defaults; only its default grants adapt to deployment regions. */
export function defaultProductCatalog(configured: readonly RegionId[]): ProductCatalog {
  const regions = defaultProductLimits(configured);
  const source = validateProductCatalog(defaultCatalogConfig, regionIds);
  return validateProductCatalog(
    {
      ...source,
      plans: source.plans.map((plan) => {
        const deployed = plan.entitlements.allowedRegionIds.filter((id) => configured.includes(id));
        const allowedRegionIds = deployed.length ? deployed : regions.allowedRegionIds;
        return {
          ...plan,
          entitlements: {
            ...plan.entitlements,
            regions: Math.min(plan.entitlements.regions, allowedRegionIds.length),
            allowedRegionIds,
          },
        };
      }),
    },
    configured,
  );
}

export async function readProductCatalog(
  control: Database,
  configured: readonly RegionId[],
  revision?: number,
): Promise<ProductCatalog> {
  if (revision === 0) return defaultProductCatalog(configured);

  const currentTable = control.table('product_catalog_current');
  const revisionsTable = control.table('product_catalog_revisions');
  const row = await pgFirst<{ revision: number; catalog: string }>(
    control,
    revision === undefined
      ? `SELECT r.revision, r.catalog FROM ${currentTable} c JOIN ${revisionsTable} r ON r.revision = c.revision WHERE c.id = 1`
      : `SELECT revision, catalog FROM ${revisionsTable} WHERE revision = $1`,
    revision === undefined ? [] : [revision],
  );
  if (!row) {
    if (revision !== undefined)
      throw new ProductTierError(409, 'catalog_missing', 'Pinned catalog revision is unavailable');
    const saved = await pgFirst(control, `SELECT revision FROM ${revisionsTable} LIMIT 1`);
    if (saved)
      throw new ProductTierError(
        409,
        'catalog_missing',
        'Saved catalog has no valid current revision',
      );
    return defaultProductCatalog(configured);
  }

  const catalog = validateProductCatalog(JSON.parse(row.catalog), configured);
  if (catalog.revision !== row.revision) invalid('Saved catalog revision mismatch');
  return catalog;
}

export function publicProductCatalog(catalog: ProductCatalog) {
  return {
    revision: catalog.revision,
    preview: catalog.preview,
    billingMode: catalog.billingMode,
    plans: catalog.plans.filter((plan) => plan.active && plan.published),
    capabilities: {
      checkout: false,
      customDomains: 'preview',
      notificationProviders: ['telegram', 'discord'],
    },
  };
}

export async function saveProductCatalog(
  control: Database,
  configured: readonly RegionId[],
  input: unknown,
  expectedRevision: number,
  actor: string,
  reason: string,
): Promise<ProductCatalog> {
  integer(expectedRevision, 0, 999_999_999, 'expectedRevision');
  string(actor, 'actor', 2048);
  string(reason, 'reason', 500);
  const catalog = validateProductCatalog(input, configured);
  if (catalog.revision !== expectedRevision + 1)
    invalid('Next catalog revision must equal expectedRevision + 1');

  try {
    await control.transaction(async (tx) => {
      // Lock service_controls row 1 to serialize catalog creation across concurrent sessions
      // especially when expectedRevision is 0 and product_catalog_current has no row yet to lock.
      await pgFirst<{ id: number }>(
        tx,
        `SELECT id FROM ${tx.table('service_controls')} WHERE id = 1 FOR NO KEY UPDATE`,
      );

      const current = await pgFirst<{ revision: number }>(
        tx,
        `SELECT revision FROM ${tx.table('product_catalog_current')} WHERE id = 1 FOR UPDATE`,
      );
      const currentRev = current?.revision ?? 0;
      if (currentRev !== expectedRevision) {
        throw new ProductTierError(
          409,
          'catalog_conflict',
          'Catalog changed; reload before saving',
        );
      }

      await pgRun(
        tx,
        `INSERT INTO ${tx.table('product_catalog_revisions')} (revision, parent_revision, catalog, actor, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          catalog.revision,
          expectedRevision,
          JSON.stringify(catalog),
          actor,
          reason,
          new Date().toISOString(),
        ],
      );

      await pgRun(
        tx,
        `INSERT INTO ${tx.table('product_catalog_current')} (id, revision)
         VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision`,
        [catalog.revision],
      );
    });
    return catalog;
  } catch (err) {
    if (err instanceof ProductTierError) throw err;
    if (isPostgresUniqueViolation(err)) {
      throw new ProductTierError(
        409,
        'catalog_conflict',
        'Catalog changed; reload before saving',
      );
    }
    throw err;
  }
}

export interface EffectiveTier {
  tierId: string;
  revision: number;
  generation: number;
  legacyExempt: boolean;
  entitlements: TierEntitlements;
  overrides: { monitors: number; regions: number; allowedRegionIds: RegionId[] } | null;
}

export async function resolveEffectiveEntitlements(
  control: Database,
  workspaceId: string,
  configured: readonly RegionId[],
): Promise<EffectiveTier> {
  const row = await pgFirst<{
    tier_id: string;
    catalog_revision: number;
    generation: number;
    legacy_exempt: number;
  }>(
    control,
    `SELECT tier_id, catalog_revision, generation, legacy_exempt
     FROM ${control.table('workspace_tier_assignments')}
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  const catalog = await readProductCatalog(control, configured, row?.catalog_revision ?? 0);
  const plan = catalog.plans.find((plan) => plan.id === (row?.tier_id ?? 'free'));
  if (!plan) throw new ProductTierError(409, 'tier_missing', 'Assigned tier is unavailable');

  const overrideRow = await pgFirst(
    control,
    `SELECT workspace_id FROM ${control.table('workspace_product_limits')} WHERE workspace_id = $1`,
    [workspaceId],
  );
  const overrides = overrideRow
    ? await savedWorkspaceProductLimits(control, workspaceId, configured)
    : null;

  let isLegacyImport = false;
  try {
    const reg = await pgFirst<{ source_database_id: string }>(
      control,
      `SELECT source_database_id FROM ${control.table('postgres_tenant_registry')}
       WHERE workspace_id = $1 AND status = 'assigned'`,
      [workspaceId],
    );
    if (
      reg &&
      (reg.source_database_id === '3900c94a-82a0-4422-a5f8-1a56b781cea7' ||
        reg.source_database_id === '17c009df-5b56-44cc-9776-73e0f1775b0f')
    ) {
      isLegacyImport = true;
    }
  } catch {
    // registry might not be in scope
  }

  return {
    tierId: plan.id,
    revision: catalog.revision,
    generation: row?.generation ?? 0,
    legacyExempt: row?.legacy_exempt === 1 || isLegacyImport,
    entitlements: { ...plan.entitlements, ...overrides },
    overrides,
  };
}

/** Trusted service only. Stripe/operator callers must authenticate and authorize before calling. */
export async function applyWorkspaceTier(
  control: Database,
  options: {
    workspaceId: string;
    tierId: string;
    revision: number;
    expectedGeneration: number;
    actor: string;
    reason: string;
    configuredRegionIds: readonly RegionId[];
    monitorBatch?: number;
    configuredWorkspaces?: number;
    /** Billing may restore the original free baseline without rewriting catalog defaults. */
    restoreDefaultFree?: boolean;
    /** Commit billing generation with the assignment so retries recognize their own work. */
    billingTransition?: boolean;
    /** A non-increasing fallback must preserve unsafe operator overrides while dropping paid quotas. */
    billingFallback?: boolean;
  },
): Promise<EffectiveTier> {
  if (options.revision === 0 && !(options.restoreDefaultFree && options.tierId === 'free'))
    throw new ProductTierError(
      409,
      'catalog_unpublished',
      'Save an immutable catalog revision before assigning tiers',
    );
  const catalog = await readProductCatalog(control, options.configuredRegionIds, options.revision);
  const plan = catalog.plans.find(
    (plan) => plan.id === options.tierId && plan.active && plan.published,
  );
  if (!plan) throw new ProductTierError(400, 'invalid_tier', 'Tier must be active and published');

  return control.transaction(async (tx) => {
    const now = new Date().toISOString();
    const workspace = await pgFirst<{
      id: string;
      state: string;
      execution_lease_until: string | null;
    }>(
      tx,
      `SELECT id, state, execution_lease_until FROM ${tx.table('workspaces')}
       WHERE id = $1 AND state IN ('active', 'suspended')
         AND (execution_lease_until IS NULL OR execution_lease_until <= $2)
       FOR NO KEY UPDATE`,
      [options.workspaceId, now],
    );
    if (!workspace) {
      throw new ProductTierError(
        409,
        'assignment_conflict',
        'Workspace policy changed or execution is busy',
      );
    }

    const previous = await resolveEffectiveEntitlements(
      tx,
      options.workspaceId,
      options.configuredRegionIds,
    );
    if (previous.legacyExempt)
      throw new ProductTierError(409, 'legacy_exempt', 'Imported workspace is exempt');
    if (previous.generation !== options.expectedGeneration) {
      throw new ProductTierError(
        409,
        'assignment_conflict',
        'Workspace policy changed or execution is busy',
      );
    }

    const settings = await pgFirst<{ max_workspaces: number }>(
      tx,
      `SELECT max_workspaces FROM ${tx.table('service_controls')} WHERE id = 1`,
    );
    const capacity = evaluateCapacity(
      { ...plan.entitlements, ...previous.overrides },
      options.monitorBatch ?? configuredMonitorBatch({}),
      null,
      options.configuredWorkspaces ?? settings?.max_workspaces ?? 10,
    );
    const nextEntitlements = { ...plan.entitlements, ...previous.overrides };
    const nonIncreasing =
      Object.entries(nextEntitlements).every(
        ([key, value]) =>
          typeof value !== 'number' ||
          value <= (previous.entitlements[key as keyof TierEntitlements] as number),
      ) &&
      nextEntitlements.allowedRegionIds.every((region) =>
        previous.entitlements.allowedRegionIds.includes(region),
      );
    if (!capacity.safe && !(options.billingFallback && nonIncreasing))
      throw new ProductTierError(409, 'capacity_exceeded', capacity.warnings.join('; '));

    integer(options.expectedGeneration, 0, 1_000_000_000, 'expectedGeneration');
    string(options.actor, 'actor', 2048);
    string(options.reason, 'reason', 500);

    const nextGeneration = options.expectedGeneration + 1;
    const assignResult = await tx.query(
      `INSERT INTO ${tx.table('workspace_tier_assignments')}
        (workspace_id, tier_id, catalog_revision, generation, legacy_exempt, updated_at)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (workspace_id) DO UPDATE SET
         tier_id = excluded.tier_id,
         catalog_revision = excluded.catalog_revision,
         generation = excluded.generation,
         updated_at = excluded.updated_at
       WHERE ${tx.table('workspace_tier_assignments')}.generation = $6
       RETURNING workspace_id`,
      [
        options.workspaceId,
        options.tierId,
        options.revision,
        nextGeneration,
        now,
        options.expectedGeneration,
      ],
    );

    if (assignResult.rowCount !== 1) {
      throw new ProductTierError(
        409,
        'assignment_conflict',
        'Workspace policy changed or execution is busy',
      );
    }

    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, 'tier_assigned', $3, $4, $5)`,
      [
        randomId(),
        options.workspaceId,
        options.actor,
        now,
        JSON.stringify({
          tierId: options.tierId,
          revision: options.revision,
          reason: options.reason,
          previous,
        }),
      ],
    );

    if (options.billingTransition) {
      await pgRun(
        tx,
        `UPDATE ${tx.table('workspace_billing')} SET applied_generation = $1 WHERE workspace_id = $2`,
        [nextGeneration, options.workspaceId],
      );
    }

    return resolveEffectiveEntitlements(tx, options.workspaceId, options.configuredRegionIds);
  });
}

export async function syncTierEntitlements(
  db: Database,
  effective: EffectiveTier,
): Promise<void> {
  const e = effective.entitlements;
  const result = await db.query(
    `UPDATE ${db.table('workspace_metadata')}
     SET monitor_limit = $1, region_limit = $2, allowed_region_ids = $3,
         seat_limit = $4, status_page_limit = $5, notification_destination_limit = $6, custom_domain_limit = $7,
         tier_id = $8, catalog_revision = $9, entitlement_generation = $10,
         updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     WHERE id = 1 AND entitlement_generation <= $11`,
    [
      e.monitors,
      e.regions,
      JSON.stringify(e.allowedRegionIds),
      e.seats,
      e.statusPages,
      e.notificationDestinations,
      e.customDomains,
      effective.tierId,
      effective.revision,
      effective.generation,
      effective.generation,
    ],
  );
  if (result.rowCount !== 1)
    throw new ProductTierError(409, 'policy_stale', 'Tenant policy is newer or missing');
}

export async function tierSchedulingState(db: Database) {
  const rows = await pgAll<{ id: string; reason: string }>(
    db,
    `SELECT m.id, CASE WHEN m.id NOT IN (SELECT id FROM ${db.table('tier_schedulable_monitors')})
       THEN 'product_quota_or_region_policy' ELSE '' END AS reason
     FROM ${db.table('monitors')} m WHERE enabled = 1 ORDER BY created_at, id`,
  );
  const paused = rows.filter((row) => row.reason);
  return {
    pausedMonitorCount: paused.length,
    pausedMonitors: paused,
    overLimit: paused.length > 0,
  };
}

export interface SchedulerPolicyTables {
  readonly monitorsTable: 'tier_schedulable_monitors' | 'monitors';
  readonly notificationServicesTable: 'tier_active_notification_services' | 'notification_services';
}

/** Explicit policy configuration helper for scheduler agent queries. */
export function schedulerPolicyTables(isHosted: boolean): SchedulerPolicyTables {
  return {
    monitorsTable: isHosted ? 'tier_schedulable_monitors' : 'monitors',
    notificationServicesTable: isHosted ? 'tier_active_notification_services' : 'notification_services',
  };
}
