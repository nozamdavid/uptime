import {
  purgeWorkspaceData,
  tenantReportsBucket,
  defaultProductLimits,
  resolveEffectiveEntitlements,
  syncTierEntitlements,
  tierSchedulingState,
  schedulerCapacity,
  schedulingState,
  recordBudgetPause,
  budgetEnforcementDisabled,
  type ProductLimits,
} from '@uptime/cloudflare';
import {
  pgFirst,
  resolveRuntimeWorkspace,
  type Database,
  type RuntimePostgresCatalog,
} from '@uptime/cloudflare/postgres';
import { runCoordinatorTick } from './coordinator.js';
import { parseCoordinatorEnv, type CoordinatorConfig, type CoordinatorEnv } from './env.js';
import { runReportSchedule } from './index.js';

export interface TenantJob {
  readonly workspaceId: string;
  readonly scheduledAt: string;
  readonly routingGeneration?: number;
  /** Sticky: maintenance jobs cannot probe after a resume. */
  readonly maintenanceOnly?: boolean;
}

/** Explicit internal session, never a database binding supplied by a request. */
export interface TenantDispatchEnv extends CoordinatorEnv {
  readonly controlDb: Database;
  readonly catalog: RuntimePostgresCatalog;
}

export function isTenantJob(value: unknown): value is TenantJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.workspaceId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      job.workspaceId,
    ) &&
    typeof job.scheduledAt === 'string' &&
    Number.isFinite(Date.parse(job.scheduledAt)) &&
    new Date(job.scheduledAt).toISOString() === job.scheduledAt &&
    (job.maintenanceOnly === undefined || typeof job.maintenanceOnly === 'boolean') &&
    (job.routingGeneration === undefined ||
      (Number.isSafeInteger(job.routingGeneration) && Number(job.routingGeneration) > 0))
  );
}

export interface CurrentBudgetUsage {
  readonly month: string;
  readonly observedAt: string;
  readonly cloudflareCostUsd: number;
}

/** Unknown/stale provider usage pauses probes. Native row counts are never billing usage. */
export async function budgetAllowsWork(
  control: Database,
  now: Date,
  usage?: CurrentBudgetUsage,
  enforcementDisabled = false,
): Promise<boolean> {
  // Explicit operator switch: no cost evidence is read, no pause row is written, and the
  // admission setting is left as it is.
  if (enforcementDisabled) return true;
  const settings = await pgFirst<{ monthly_budget_usd: number; external_monthly_cost_usd: number }>(
    control,
    `SELECT monthly_budget_usd, external_monthly_cost_usd FROM ${control.table('service_controls')} WHERE id = 1`,
  );
  const age = usage ? now.getTime() - Date.parse(usage.observedAt) : NaN;
  const available =
    !!usage &&
    usage.month === now.toISOString().slice(0, 7) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 3_600_000 &&
    Number.isFinite(usage.cloudflareCostUsd) &&
    usage.cloudflareCostUsd >= 0;
  const external = Number(settings?.external_monthly_cost_usd);
  const limit = Math.min(20, Number(settings?.monthly_budget_usd));
  const allowed =
    available &&
    Number.isFinite(external) &&
    external >= 0 &&
    Number.isFinite(limit) &&
    limit > 0 &&
    usage!.cloudflareCostUsd + external < limit;
  if (
    available &&
    Number.isFinite(external) &&
    external >= 0 &&
    usage!.cloudflareCostUsd + external >= 15
  )
    await control.query(
      `UPDATE ${control.table('service_controls')} SET admission_open = 0 WHERE id = 1 AND admission_open = 1`,
    );
  await recordBudgetPause(control, allowed, now);
  return allowed;
}

export function configuredBudgetUsage(env: CoordinatorEnv): CurrentBudgetUsage | undefined {
  if (typeof env.CURRENT_BUDGET_USAGE_JSON !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(env.CURRENT_BUDGET_USAGE_JSON);
    if (!value || typeof value !== 'object') return undefined;
    const usage = value as Record<string, unknown>;
    if (
      typeof usage.month !== 'string' ||
      typeof usage.observedAt !== 'string' ||
      typeof usage.cloudflareCostUsd !== 'number'
    )
      return undefined;
    return usage as unknown as CurrentBudgetUsage;
  } catch {
    return undefined;
  }
}

export interface DispatchClaim {
  readonly id: string;
  readonly workspace_id: string;
  readonly scheduled_at: string;
  /** attempts is a monotonic fencing generation, incremented only while claiming. */
  readonly attempts: number;
  readonly next_attempt_at: string;
}

/** Locks are released before network I/O. Each reclaim changes the fencing generation. */
export async function claimDispatches(
  control: Database,
  sourceIds: readonly string[],
  now: Date,
): Promise<DispatchClaim[]> {
  const timestamp = now.toISOString();
  const retryAt = new Date(now.getTime() + 60_000).toISOString();
  return control.transaction(async (tx) => {
    const { rows: due } = await tx.query<{ id: string; next_dispatch_at: string | null }>(
      `SELECT w.id, w.next_dispatch_at FROM ${tx.table('workspaces')} w
       JOIN ${tx.table('postgres_tenant_registry')} r ON r.workspace_id = w.id AND r.status = 'assigned'
       WHERE w.state = 'active' AND r.source_database_id = ANY($1::text[])
         AND (w.next_dispatch_at IS NULL OR w.next_dispatch_at <= $2)
       ORDER BY COALESCE(w.next_dispatch_at, '0000'), w.id
       LIMIT $3 FOR UPDATE OF w SKIP LOCKED`,
      [sourceIds, timestamp, schedulerCapacity.dispatchesPerMinute],
    );
    for (const workspace of due) {
      // After downtime, skip the missed windows. Walking them one per minute never catches up,
      // and once a slot is older than the 7 day job window runTenantJob drops every dispatch.
      const behindMs = workspace.next_dispatch_at
        ? now.getTime() - Date.parse(workspace.next_dispatch_at)
        : NaN;
      const scheduledAt = behindMs <= 60_000 ? workspace.next_dispatch_at! : timestamp;
      await tx.query(
        `INSERT INTO ${tx.table('dispatch_outbox')}
         (id, workspace_id, scheduled_at, status, attempts, next_attempt_at, created_at)
         VALUES ($1, $2, $3, 'pending', 0, $4, $4)
         ON CONFLICT (workspace_id, scheduled_at) DO NOTHING`,
        [`${workspace.id}:${scheduledAt}`, workspace.id, scheduledAt, timestamp],
      );
      await tx.query(
        `UPDATE ${tx.table('workspaces')} SET next_dispatch_at = $1, updated_at = $2 WHERE id = $3`,
        [new Date(Date.parse(scheduledAt) + 60_000).toISOString(), timestamp, workspace.id],
      );
    }
    const { rows } = await tx.query<DispatchClaim>(
      `WITH due AS (
         SELECT o.id FROM ${tx.table('dispatch_outbox')} o
         JOIN ${tx.table('workspaces')} w ON w.id = o.workspace_id
         JOIN ${tx.table('postgres_tenant_registry')} r ON r.workspace_id = w.id AND r.status = 'assigned'
         WHERE o.status = 'pending' AND o.next_attempt_at <= $1 AND w.state = 'active'
           AND r.source_database_id = ANY($2::text[])
         ORDER BY o.next_attempt_at, o.id LIMIT $3 FOR UPDATE OF o SKIP LOCKED
       ) UPDATE ${tx.table('dispatch_outbox')} o SET attempts = o.attempts + 1, next_attempt_at = $4
         FROM due WHERE o.id = due.id RETURNING o.*`,
      [timestamp, sourceIds, schedulerCapacity.dispatchesPerMinute, retryAt],
    );
    return rows;
  });
}

export async function finishDispatch(
  control: Database,
  claim: DispatchClaim,
  now: Date,
  success: boolean,
): Promise<boolean> {
  const result = await control.query(
    `UPDATE ${control.table('dispatch_outbox')} SET
       status = CASE WHEN $1 = 1 THEN 'sent' ELSE 'pending' END,
       attempts = attempts + CASE WHEN $1 = 1 THEN 0 ELSE 1 END,
       dispatched_at = CASE WHEN $1 = 1 THEN $2 ELSE dispatched_at END,
       next_attempt_at = $3, last_error = CASE WHEN $1 = 1 THEN NULL ELSE 'Queue send failed' END
     WHERE id = $4 AND status = 'pending' AND attempts = $5 AND next_attempt_at = $6 RETURNING id`,
    [
      success ? 1 : 0,
      now.toISOString(),
      new Date(now.getTime() + 60_000).toISOString(),
      claim.id,
      claim.attempts,
      claim.next_attempt_at,
    ],
  );
  return result.rowCount === 1;
}

export async function dispatchDueTenants(env: TenantDispatchEnv, now = new Date()) {
  const control = env.controlDb;
  // Cleanup precedes all pause decisions.
  await control.query(
    `DELETE FROM ${control.table('dispatch_outbox')} WHERE id IN
    (SELECT id FROM ${control.table('dispatch_outbox')} WHERE status = 'sent' AND dispatched_at < $1 LIMIT 100)`,
    [new Date(now.getTime() - 7 * 86_400_000).toISOString()],
  );
  await control.query(
    `DELETE FROM ${control.table('request_budgets')} WHERE key IN
    (SELECT key FROM ${control.table('request_budgets')} WHERE window_started_at < $1 LIMIT 100)`,
    [new Date(now.getTime() - 2 * 86_400_000).toISOString()],
  );
  const { rows: deleting } = await control.query<{ id: string; source_database_id: string | null }>(
    `SELECT w.id, r.source_database_id FROM ${control.table('workspaces')} w
     LEFT JOIN ${control.table('postgres_tenant_registry')} r ON r.workspace_id = w.id
     WHERE w.state = 'deleting' ORDER BY w.updated_at LIMIT 5`,
  );
  for (const workspace of deleting) {
    const source = env.catalog.sources.find(
      (entry) => entry.sourceDatabaseId === workspace.source_database_id,
    );
    if (workspace.source_database_id && !source)
      throw new Error('Deleting workspace source is outside the trusted catalog');
    if (source && source.profile !== 'full-hosted') continue;
    await purgeWorkspaceData(
      { ...env, controlDb: control, catalog: env.catalog.sources },
      workspace.id,
      now,
    );
  }
  const budgetOff = budgetEnforcementDisabled(env);
  const allowed = await budgetAllowsWork(control, now, configuredBudgetUsage(env), budgetOff);
  const claims = await claimDispatches(
    control,
    env.catalog.sources
      .filter((source) => source.profile === 'full-hosted')
      .map((source) => source.sourceDatabaseId),
    now,
  );
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      if (!env.TENANT_JOBS) throw new Error('TENANT_JOBS is required');
      const maintenanceOnly =
        !allowed ||
        (await schedulingState(control, claim.workspace_id, { ignoreBudget: budgetOff })).paused;
      await env.TENANT_JOBS.send({
        workspaceId: claim.workspace_id,
        scheduledAt: claim.scheduled_at,
        routingGeneration: claim.attempts,
        maintenanceOnly,
      });
      if (await finishDispatch(control, claim, new Date(), true)) sent += 1;
    } catch {
      failed += 1;
      await finishDispatch(control, claim, new Date(), false);
    }
  }
  return { attempted: claims.length, sent, failed };
}

export function enforceFreePolicy(
  config: CoordinatorConfig,
  limits: ProductLimits = defaultProductLimits(config.enabledRegionIds),
): CoordinatorConfig {
  const configured = new Set(config.enabledRegionIds);
  const selected = limits.allowedRegionIds;
  if (selected.length === 0 || selected.some((region) => !configured.has(region)))
    throw new Error('Workspace policy includes a region that is not configured');
  return {
    ...config,
    enabledRegionIds: selected,
    enabledRegions: selected
      .map((region) => config.enabledRegions.find((item) => item.id === region)!)
      .filter(Boolean),
    detailedResultsRetentionDays: 1,
    dnsDiagnosticsRetentionDays: 30,
  };
}

export async function runTenantJob(
  env: TenantDispatchEnv,
  job: TenantJob,
  now = new Date(),
): Promise<void> {
  if (!isTenantJob(job)) throw new Error('Invalid tenant job');
  const control = env.controlDb;
  const workspace = await pgFirst<{ state: string }>(
    control,
    `SELECT state FROM ${control.table('workspaces')} WHERE id = $1`,
    [job.workspaceId],
  );
  if (!workspace || workspace.state !== 'active') return;
  const registry = await pgFirst<{ source_database_id: string }>(
    control,
    `SELECT source_database_id FROM ${control.table('postgres_tenant_registry')} WHERE workspace_id = $1 AND status = 'assigned'`,
    [job.workspaceId],
  );
  const source = env.catalog.sources.find(
    (entry) => entry.sourceDatabaseId === registry?.source_database_id,
  );
  if (source && source.profile !== 'full-hosted') return;
  const scheduledMs = Date.parse(job.scheduledAt);
  if (scheduledMs < now.getTime() - 7 * 86_400_000 || scheduledMs > now.getTime() + 60_000) return;
  const outbox = await pgFirst<{ attempts: number }>(
    control,
    `SELECT attempts FROM ${control.table('dispatch_outbox')} WHERE workspace_id = $1 AND scheduled_at = $2`,
    [job.workspaceId, job.scheduledAt],
  );
  if (!outbox || (job.routingGeneration !== undefined && job.routingGeneration > outbox.attempts))
    throw new Error('Tenant job has no matching dispatch');
  const token = crypto.randomUUID();
  const lease = await control.query(
    `UPDATE ${control.table('workspaces')} SET execution_lease_token = $1, execution_lease_until = $2, updated_at = $3
     WHERE id = $4 AND state = 'active' AND (execution_lease_until IS NULL OR execution_lease_until <= $3) RETURNING id`,
    [
      token,
      new Date(now.getTime() + 16 * 60_000).toISOString(),
      now.toISOString(),
      job.workspaceId,
    ],
  );
  if (lease.rowCount !== 1) {
    const workspace = await pgFirst<{ state: string }>(
      control,
      `SELECT state FROM ${control.table('workspaces')} WHERE id = $1`,
      [job.workspaceId],
    );
    if (workspace?.state === 'active') throw new Error('Tenant workspace lease is busy');
    return;
  }
  try {
    const resolved = await resolveRuntimeWorkspace(control, env.catalog, job.workspaceId);
    if (resolved.schedulingPolicy !== 'hosted') return;
    const db = resolved.db;
    const jobName = `dispatch:${job.scheduledAt}`;
    const prior = await pgFirst<{ last_completed_at: string | null }>(
      db,
      `SELECT last_completed_at FROM ${db.table('jobs')} WHERE name = $1`,
      [jobName],
    );
    if (prior?.last_completed_at) return;
    const budgetOff = budgetEnforcementDisabled(env);
    const allowed = await budgetAllowsWork(control, now, configuredBudgetUsage(env), budgetOff);
    const maintenanceOnly =
      job.maintenanceOnly === true ||
      !allowed ||
      (await schedulingState(control, job.workspaceId, { ignoreBudget: budgetOff })).paused;
    const reports = env.REPORTS ? tenantReportsBucket(env.REPORTS, job.workspaceId) : undefined;
    const parsed = {
      ...parseCoordinatorEnv({ ...env, ...(reports ? { REPORTS: reports } : {}) }, db),
      schedulingPolicy: 'hosted' as const,
    };
    // All control reads finish before tenant callbacks on this physical connection.
    const effective = maintenanceOnly
      ? null
      : await resolveEffectiveEntitlements(control, job.workspaceId, parsed.enabledRegionIds);
    const config = effective ? enforceFreePolicy(parsed, effective.entitlements) : parsed;
    await db.query(
      `DELETE FROM ${db.table('monitor_daily_uptime')} WHERE (monitor_id, day) IN
       (SELECT monitor_id, day FROM ${db.table('monitor_daily_uptime')} WHERE day < $1 LIMIT 100)`,
      [new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)],
    );
    if (effective) {
      await syncTierEntitlements(db, effective);
      const state = await tierSchedulingState(db);
      if (state.overLimit)
        console.warn({ event: 'tenant_product_quota_pause', workspaceId: job.workspaceId });
    }
    await runCoordinatorTick(
      config,
      { fetch: globalThis.fetch.bind(globalThis), log: console },
      { maintenanceOnly },
    );
    await runReportSchedule(config, now, maintenanceOnly || config.reportScheduleDisabled);
    await db.transaction(async (tx) => {
      // Qualified control SQL on the pinned tenant transaction avoids queueing behind itself.
      const owner = await pgFirst<{ execution_lease_token: string }>(
        tx,
        `SELECT execution_lease_token FROM ${control.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
        [job.workspaceId],
      );
      if (owner?.execution_lease_token !== token)
        throw new Error('Tenant execution lease was replaced');
      await tx.query(
        `INSERT INTO ${tx.table('jobs')} (name, last_completed_at, updated_at) VALUES ($1, $2, $2)
        ON CONFLICT (name) DO UPDATE SET last_completed_at = excluded.last_completed_at, updated_at = excluded.updated_at`,
        [jobName, new Date().toISOString()],
      );
      await tx.query(
        `DELETE FROM ${tx.table('jobs')} WHERE name IN (SELECT name FROM ${tx.table('jobs')}
        WHERE name LIKE 'dispatch:%' AND last_completed_at < $1 LIMIT 100)`,
        [new Date(now.getTime() - 7 * 86_400_000).toISOString()],
      );
    });
  } finally {
    await control.query(
      `UPDATE ${control.table('workspaces')} SET execution_lease_token = NULL, execution_lease_until = NULL
      WHERE id = $1 AND execution_lease_token = $2`,
      [job.workspaceId, token],
    );
  }
}

/** Historical D1 work only, never called with native query telemetry. */
export async function recordWorkspaceUsage(
  control: Database,
  workspaceId: string,
  now: Date,
  queryWork: Record<string, { rowsRead: number; rowsWritten: number }>,
  checks = 1,
  storageBytes = 0,
): Promise<void> {
  const totals = Object.values(queryWork).reduce(
    (sum, work) => ({
      rowsRead: sum.rowsRead + Number(work.rowsRead || 0),
      rowsWritten: sum.rowsWritten + Number(work.rowsWritten || 0),
    }),
    { rowsRead: 0, rowsWritten: 0 },
  );
  await control.query(
    `INSERT INTO ${control.table('workspace_usage_daily')} AS usage
    (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (workspace_id, day) DO UPDATE SET checks = usage.checks + excluded.checks,
    rows_read = usage.rows_read + excluded.rows_read, rows_written = usage.rows_written + excluded.rows_written,
    storage_bytes = GREATEST(usage.storage_bytes, excluded.storage_bytes), updated_at = excluded.updated_at`,
    [
      workspaceId,
      now.toISOString().slice(0, 10),
      checks,
      totals.rowsRead,
      totals.rowsWritten,
      storageBytes,
      now.toISOString(),
    ],
  );
}
