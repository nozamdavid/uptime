import { schedulingState, type CloudflareEnv } from '@uptime/cloudflare';
import {
  pgAll as all,
  pgFirst as first,
  resolveRuntimeWorkspace,
  type Database,
  type RuntimePostgresCatalog,
} from '@uptime/cloudflare/postgres';

export async function workspaceTelemetry(db: Database, now: Date) {
  const jobs = await all<{
    name: string;
    last_completed_at: string | null;
    state_json: string | null;
  }>(
    db,
    `SELECT name,last_completed_at,state_json FROM ${db.table('jobs')} WHERE name IN ('coordinator','reports')`,
  );
  const coordinator = jobs.find((job) => job.name === 'coordinator');
  const publication = await first<{ updated_at: string }>(
    db,
    `SELECT updated_at FROM ${db.table('report_publications')} WHERE report_key='cohort' AND status='complete'`,
  );
  // The cohort pointer commits all scheduled status pages and the index together.
  // Monitor snapshots are refreshed on demand; retired rows await bounded cleanup.
  const oldestPublication = publication;
  const failedPublications = await all<{ report_key: string }>(
    db,
    `SELECT report_key FROM ${db.table('report_publications')} WHERE report_key='cohort' AND status='failed' LIMIT 101`,
  );
  const state = coordinator?.state_json
    ? (JSON.parse(coordinator.state_json) as Record<string, unknown>)
    : null;
  const overdue = await first<{ next_check_at: string }>(
    db,
    `SELECT next_check_at FROM ${db.table('monitors')} WHERE enabled=1 AND next_check_at < $1 ORDER BY next_check_at LIMIT 1`,
    [now.toISOString()],
  );
  const failures = await all<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('notification_deliveries')} WHERE status='failed' ORDER BY next_attempt_at LIMIT 101`,
  );
  const downTargets = await all<{ monitor_id: string }>(
    db,
    `SELECT monitor_id FROM ${db.table('monitor_notification_state')} WHERE
      monitor_id IN (SELECT id FROM ${db.table('monitors')} WHERE enabled=1) AND status='down' LIMIT 101`,
  );
  return {
    lastSuccessfulTickAt: coordinator?.last_completed_at ?? null,
    oldestOverdueCheckAt: overdue?.next_check_at ?? null,
    regionalProbes: state?.regionalProbes ?? null,
    targetIncidents: {
      downCount: Math.min(downTargets.length, 100),
      truncated: downTargets.length > 100,
    },
    reports: {
      lastSuccessfulAt: publication?.updated_at ?? null,
      oldestSuccessfulAt: oldestPublication?.updated_at ?? null,
      failedCount: Math.min(failedPublications.length, 100),
      truncated: failedPublications.length > 100,
      stale:
        failedPublications.length > 0
          ? true
          : oldestPublication?.updated_at
            ? now.getTime() - Date.parse(oldestPublication.updated_at) > 180_000
            : null,
    },
    notificationFailures: {
      count: Math.min(failures.length, 100),
      truncated: failures.length > 100,
    },
  };
}

export async function operatorHealth(
  env: CloudflareEnv & { controlDb: Database; catalog: RuntimePostgresCatalog },
  url: URL,
  budget: { forecastUsd: number | null; ceilingUsd: number; enforcementDisabled?: boolean },
  now = new Date(),
) {
  const control = env.controlDb;
  const requested = Number(url.searchParams.get('limit') ?? 5);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(5, requested)) : 5;
  const rows = await all<{ id: string }>(
    control,
    `SELECT w.id FROM ${control.table('workspaces')} w JOIN ${control.table('postgres_tenant_registry')} s ON s.workspace_id=w.id AND s.status='assigned'
     WHERE w.id > $1 ORDER BY w.id LIMIT $2`,
    [url.searchParams.get('after') ?? '', limit + 1],
  );
  const pending = await all<{ created_at: string; attempts: number; last_error: string | null }>(
    control,
    `SELECT created_at,attempts,last_error FROM ${control.table('dispatch_outbox')} WHERE status='pending' ORDER BY created_at LIMIT 101`,
  );
  const oldestPendingAt = pending[0]?.created_at ?? null;
  const effectiveScheduling = async (workspaceId?: string) => {
    const state = await schedulingState(control, workspaceId, {
      ignoreBudget: budget.enforcementDisabled === true,
    });
    if (
      !budget.enforcementDisabled &&
      (budget.forecastUsd === null || budget.forecastUsd >= budget.ceilingUsd)
    ) {
      state.paused = true;
      state.automatic ??= {
        scope: 'budget',
        paused: true,
        reason:
          budget.forecastUsd === null
            ? 'Current Cloudflare cost is unknown or stale'
            : 'Live monthly forecast reached the dispatch ceiling',
        actor: 'system:budget',
        changedAt: now.toISOString(),
      };
    }
    return state;
  };
  const workspaces = await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const scheduling = await effectiveScheduling(row.id);
      try {
        const resolved = await resolveRuntimeWorkspace(control, env.catalog, row.id);
        const imported = resolved.source.profile !== 'full-hosted';
        const source = imported
          ? resolved.source.profile === 'legacy-staging'
            ? 'staging_import'
            : 'production_import'
          : 'hosted';
        const db = resolved.db;
        const runtime = imported
          ? await first<{ last_seen_at: string }>(
              control,
              `SELECT last_seen_at FROM ${control.table('coordinator_runtime_health')} WHERE workspace_id=$1`,
              [row.id],
            )
          : null;
        return {
          workspaceId: row.id,
          source,
          scheduling,
          schedulingEnforcement: imported
            ? {
                observedAt: runtime?.last_seen_at ?? null,
                confirmed: runtime
                  ? now.getTime() - Date.parse(runtime.last_seen_at) < 180_000
                  : false,
              }
            : { observedAt: null, confirmed: true },
          telemetry: await workspaceTelemetry(db, now),
          error: null,
        };
      } catch (error) {
        return {
          workspaceId: row.id,
          source: null,
          scheduling,
          telemetry: null,
          error: String(error),
        };
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    scheduling: await effectiveScheduling(),
    budget,
    dispatch: {
      oldestPendingAt,
      pendingAgeSeconds: oldestPendingAt
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestPendingAt)) / 1000))
        : null,
      failedCount: pending.slice(0, 100).filter((row) => row.last_error !== null).length,
      truncated: pending.length > 100,
      deadLetterCount: null,
    },
    workspaces,
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
