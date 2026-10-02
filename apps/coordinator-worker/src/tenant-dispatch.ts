import {
  randomToken,
  flushUsage,
  meterDatabase,
  purgeWorkspaceData,
  resolveWorkspaceDatabase,
  tenantReportsBucket,
  type D1Database,
  type R2Bucket,
} from '@uptime/cloudflare';

import { runCoordinatorTick } from './coordinator.js';
import { parseCoordinatorEnv, type CoordinatorConfig, type CoordinatorEnv } from './env.js';
import { runReportSchedule } from './index.js';

export interface TenantJob {
  readonly workspaceId: string;
  readonly scheduledAt: string;
  readonly routingGeneration?: number;
}

export interface TenantDispatchEnv extends CoordinatorEnv {
  CONTROL_DB: D1Database;
  TENANT_JOBS?: Queue<TenantJob>;
}

interface DueWorkspace {
  id: string;
  next_dispatch_at: string | null;
}

const dispatchLimit = 20;
const dispatchRetrySeconds = 60;
const preferredFreeRegions = ['eu-west', 'us-east', 'asia'] as const;

function isoNow(now: Date): string {
  return now.toISOString();
}

function dispatchKey(workspaceId: string, scheduledAt: string): string {
  return `${workspaceId}:${scheduledAt}`;
}

export async function budgetAllowsWork(control: D1Database, now: Date): Promise<boolean> {
  const settings = await control
    .prepare(
      'SELECT monthly_budget_usd, admission_open, external_monthly_cost_usd FROM service_controls WHERE id = 1',
    )
    .first<{
      monthly_budget_usd: number;
      admission_open: number;
      external_monthly_cost_usd: number;
    }>();
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const usage = await control
    .prepare(
      `SELECT COALESCE(SUM(rows_read), 0) AS reads, COALESCE(SUM(rows_written), 0) AS writes,
      COALESCE((SELECT SUM(storage_bytes) FROM (
        SELECT workspace_id, MAX(storage_bytes) AS storage_bytes FROM workspace_usage_daily
        WHERE day >= ? GROUP BY workspace_id
      )), 0) AS storage FROM workspace_usage_daily WHERE day >= ?`,
    )
    .bind(cutoff, cutoff)
    .first<{ reads: number; writes: number; storage: number }>();
  const firstDay = await control
    .prepare('SELECT MIN(day) AS first_day FROM workspace_usage_daily WHERE day >= ?')
    .bind(cutoff)
    .first<{ first_day: string | null }>();
  const elapsed = firstDay?.first_day
    ? Math.floor((now.getTime() - Date.parse(firstDay.first_day)) / 86_400_000) + 1
    : 1;
  const factor = 31 / Math.min(31, Math.max(1, elapsed));
  const forecast =
    5 +
    Number(settings?.external_monthly_cost_usd ?? 0) +
    (Math.max(0, Number(usage?.reads ?? 0) * factor - 25_000_000_000) / 1_000_000) * 0.001 +
    Math.max(0, Number(usage?.writes ?? 0) * factor - 50_000_000) / 1_000_000 +
    Math.max(0, Number(usage?.storage ?? 0) / 1_000_000_000 - 5) * 0.75;
  if (forecast >= 15 && settings?.admission_open === 1) {
    await control.prepare('UPDATE service_controls SET admission_open = 0 WHERE id = 1').run();
  }
  return forecast < Math.min(20, Number(settings?.monthly_budget_usd ?? 20));
}

/**
 * Claims a bounded set of due tenants and records an outbox row before sending.
 * A failed queue send leaves the outbox row pending, so the next cron invocation
 * retries it instead of losing the dispatch or advancing the schedule silently.
 */
export async function dispatchDueTenants(
  env: TenantDispatchEnv,
  now = new Date(),
): Promise<{ attempted: number; sent: number; failed: number }> {
  const control = env.CONTROL_DB;
  const nowIso = isoNow(now);
  const outboxCutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const budgetCutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  await control.batch([
    control
      .prepare(
        `DELETE FROM dispatch_outbox WHERE id IN
        (SELECT id FROM dispatch_outbox WHERE status = 'sent' AND dispatched_at < ? LIMIT 100)`,
      )
      .bind(outboxCutoff),
    control
      .prepare(
        `DELETE FROM request_budgets WHERE rowid IN
        (SELECT rowid FROM request_budgets WHERE window_started_at < ? LIMIT 100)`,
      )
      .bind(budgetCutoff),
  ]);
  const deleting = await control
    .prepare("SELECT id FROM workspaces WHERE state = 'deleting' ORDER BY updated_at LIMIT 5")
    .all<{ id: string }>();
  for (const workspace of deleting.results) await purgeWorkspaceData(env, workspace.id, now);
  if (!(await budgetAllowsWork(control, now))) return { attempted: 0, sent: 0, failed: 0 };
  const rows = await control
    .prepare(
      `SELECT id, next_dispatch_at FROM workspaces
       WHERE state = 'active' AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)
       ORDER BY COALESCE(next_dispatch_at, '0000-01-01T00:00:00.000Z'), id
       LIMIT ?`,
    )
    .bind(nowIso, dispatchLimit)
    .all<DueWorkspace>();

  let sent = 0;
  let failed = 0;
  for (const workspace of rows.results ?? []) {
    const scheduledAt = workspace.next_dispatch_at ?? nowIso;
    const key = dispatchKey(workspace.id, scheduledAt);
    await control
      .prepare(
        `INSERT INTO dispatch_outbox
           (id, workspace_id, scheduled_at, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT (workspace_id, scheduled_at) DO NOTHING`,
      )
      .bind(key, workspace.id, scheduledAt, nowIso, nowIso)
      .run();

    // A row already marked sent is safe to skip. Pending rows are retried after
    // a previous enqueue failure or a process crash between enqueue and update.
    const existing = await control
      .prepare(
        `SELECT id, status FROM dispatch_outbox
         WHERE id = ?`,
      )
      .bind(key)
      .first<{ id: string; status: 'pending' | 'sent' }>();
    if (!existing) continue;
    if (existing.status === 'sent') {
      await control
        .prepare(
          `UPDATE workspaces SET next_dispatch_at = ?, updated_at = ?
           WHERE id = ? AND state = 'active' AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)`,
        )
        .bind(
          new Date(Date.parse(scheduledAt) + 60_000).toISOString(),
          nowIso,
          workspace.id,
          nowIso,
        )
        .run();
      continue;
    }
    const pending = await control
      .prepare(`SELECT id FROM dispatch_outbox WHERE id = ? AND next_attempt_at <= ?`)
      .bind(key, nowIso)
      .first<{ id: string }>();
    if (!pending) continue;

    try {
      if (!env.TENANT_JOBS) throw new Error('Missing required binding: TENANT_JOBS');
      await env.TENANT_JOBS.send({ workspaceId: workspace.id, scheduledAt });
      await control
        .prepare(
          `UPDATE dispatch_outbox
           SET status = 'sent', attempts = attempts + 1, dispatched_at = ?, next_attempt_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(nowIso, nowIso, key)
        .run();
      await control
        .prepare(
          `UPDATE workspaces SET next_dispatch_at = ?, updated_at = ?
           WHERE id = ? AND state = 'active'`,
        )
        .bind(new Date(Date.parse(scheduledAt) + 60_000).toISOString(), nowIso, workspace.id)
        .run();
      sent += 1;
    } catch (error) {
      failed += 1;
      await control
        .prepare(
          `UPDATE dispatch_outbox
           SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(
          new Date(now.getTime() + dispatchRetrySeconds * 1_000).toISOString(),
          String(error),
          key,
        )
        .run()
        .catch(() => undefined);
    }
  }
  return { attempted: rows.results?.length ?? 0, sent, failed };
}

export function enforceFreePolicy(config: CoordinatorConfig): CoordinatorConfig {
  const configured = new Set(config.enabledRegionIds);
  const selected = [
    ...preferredFreeRegions.filter((region) =>
      configured.has(region as (typeof config.enabledRegionIds)[number]),
    ),
    ...config.enabledRegionIds.filter(
      (region) => !preferredFreeRegions.includes(region as (typeof preferredFreeRegions)[number]),
    ),
  ].slice(0, 3);
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

async function enforceMonitorLimits(db: D1Database): Promise<void> {
  // These updates are idempotent and keep tenant-authored monitor settings
  // within the free plan before a tick snapshots them into check_runs.
  await db.batch([
    db.prepare('UPDATE monitors SET timeout_ms = MIN(timeout_ms, 10000) WHERE timeout_ms > 10000'),
    db.prepare(
      'UPDATE monitors SET dns_diagnostics_enabled = 0 WHERE dns_diagnostics_enabled <> 0',
    ),
    db.prepare(
      'UPDATE monitors SET outage_threshold = MIN(outage_threshold, 2), recovery_threshold = MIN(recovery_threshold, 1)',
    ),
    db.prepare(`DELETE FROM monitor_notification_services
        WHERE rowid IN (
          SELECT rowid FROM (
            SELECT rowid, ROW_NUMBER() OVER (
              PARTITION BY monitor_id ORDER BY notification_service_id
            ) AS destination_number
            FROM monitor_notification_services
          ) WHERE destination_number > 3
        )`),
    db.prepare(`DELETE FROM monitor_daily_uptime WHERE rowid IN (
        SELECT rowid FROM monitor_daily_uptime WHERE day < date('now', '-30 days') LIMIT 100
      )`),
  ]);
}

export async function runTenantJob(
  env: TenantDispatchEnv,
  job: TenantJob,
  now = new Date(),
): Promise<void> {
  const workspace = await env.CONTROL_DB.prepare(
    'SELECT state FROM workspaces WHERE id = ? LIMIT 1',
  )
    .bind(job.workspaceId)
    .first<{ state: string }>();
  if (!workspace || workspace.state !== 'active') return;
  const leaseToken = randomToken(16);
  const leaseUntil = new Date(now.getTime() + 16 * 60_000).toISOString();
  const lease = await env.CONTROL_DB.prepare(
    `UPDATE workspaces SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
       WHERE id = ? AND state = 'active'
         AND (execution_lease_until IS NULL OR execution_lease_until <= ?)
       RETURNING id`,
  )
    .bind(leaseToken, leaseUntil, now.toISOString(), job.workspaceId, now.toISOString())
    .first<{ id: string }>();
  if (!lease) throw new Error(`Tenant workspace lease is busy: ${job.workspaceId}`);
  let meter: ReturnType<typeof meterDatabase> | undefined;
  let checks = 0;
  try {
    const rawDb = await resolveWorkspaceDatabase(env, job.workspaceId);
    if (!(await budgetAllowsWork(env.CONTROL_DB, now))) {
      throw new Error('Hosted budget forecast reached the dispatch ceiling');
    }
    meter = meterDatabase(rawDb);
    const db = meter.db;
    await enforceMonitorLimits(db);
    const reports = env.REPORTS ? tenantReportsBucket(env.REPORTS, job.workspaceId) : null;
    const config = enforceFreePolicy(
      parseCoordinatorEnv({ ...env, DB: db, REPORTS: reports } as CoordinatorEnv),
    );
    const result = await runCoordinatorTick(config, {
      fetch: globalThis.fetch.bind(globalThis),
      log: console,
    });
    checks = result.metrics.roundsClaimed;
    await runReportSchedule(config, now);
  } finally {
    if (meter) {
      await flushUsage(env.CONTROL_DB, job.workspaceId, meter.usage, now, checks).catch((error) => {
        console.warn({
          event: 'tenant_usage_flush_failed',
          workspaceId: job.workspaceId,
          error: String(error),
        });
      });
    }
    await env.CONTROL_DB.prepare(
      `UPDATE workspaces SET execution_lease_token = NULL, execution_lease_until = NULL
         WHERE id = ? AND execution_lease_token = ?`,
    )
      .bind(job.workspaceId, leaseToken)
      .run()
      .catch(() => undefined);
  }
}

export async function recordWorkspaceUsage(
  control: D1Database,
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
  await control
    .prepare(
      `INSERT INTO workspace_usage_daily
         (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, day) DO UPDATE SET
         checks = checks + excluded.checks, rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written,
         storage_bytes = MAX(storage_bytes, excluded.storage_bytes), updated_at = excluded.updated_at`,
    )
    .bind(
      workspaceId,
      now.toISOString().slice(0, 10),
      checks,
      totals.rowsRead,
      totals.rowsWritten,
      storageBytes,
      now.toISOString(),
    )
    .run();
}
