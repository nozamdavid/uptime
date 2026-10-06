import { randomToken } from './crypto.js';
import type { Database } from './postgres/database.js';
import { scopePostgresDatabase } from './postgres/database.js';
import { pgFirst, pgRun } from './postgres/query.js';
import type { PostgresTenantCatalogEntry } from './postgres/tenancy.js';
import { isImportedWorkspace } from './staging-import.js';
import { tenantReportsBucket } from './tenancy.js';
import type { R2Bucket } from './workers-types.js';

export interface TenantLifecycleEnv {
  control?: Database;
  controlDb?: Database;
  catalog?: readonly PostgresTenantCatalogEntry[];
  REPORTS?: R2Bucket;
  reports?: R2Bucket;
  readonly [binding: string]: unknown;
}

interface DeletingWorkspace {
  id: string;
  owner_did: string;
  state: 'deleting' | 'deleted';
  execution_lease_until: string | null;
}

/**
 * Irreversibly purge a deleting workspace after its execution lease has ended.
 *
 * A false return means a live lease or more R2 objects remain, so the caller
 * should retry later. A mismatch between the control-plane slot and tenant
 * identity is an error: deleting an incorrectly routed database is never safe.
 */
export async function purgeWorkspaceData(
  env: TenantLifecycleEnv,
  workspaceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const control = env.control ?? env.controlDb;
  if (!control) {
    throw new Error('Control database is required for tenant lifecycle operations');
  }
  const reports = env.reports ?? env.REPORTS;
  const catalog = env.catalog;

  if (await isImportedWorkspace(control, workspaceId, catalog)) {
    throw new Error('Imported data cannot be purged through workspace deletion');
  }

  return control.transaction(async (tx) => {
    const timestamp = now.toISOString();
    const workspace = await pgFirst<DeletingWorkspace>(
      tx,
      `SELECT id, owner_did, state, execution_lease_until
       FROM ${tx.table('workspaces')}
       WHERE id = $1 AND state IN ('deleting', 'deleted')
       FOR UPDATE`,
      [workspaceId],
    );
    if (!workspace || workspace.state === 'deleted') return true;
    if (workspace.execution_lease_until && workspace.execution_lease_until > timestamp) {
      return false;
    }

    if (reports && !(await purgeReports(reports, workspaceId))) {
      return false;
    }

    let registryRow: { source_database_id: string; schema_name: string; status: string } | null =
      null;
    try {
      registryRow = await pgFirst(
        tx,
        `SELECT source_database_id, schema_name, status
         FROM ${tx.table('postgres_tenant_registry')}
         WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
    } catch {
      // Table might not exist in old test schemas
    }

    if (registryRow && catalog) {
      const entry = catalog.find(
        (c) => c.sourceDatabaseId === registryRow!.source_database_id,
      );
      if (entry) {
        const tenant = scopePostgresDatabase(tx, entry);
        const identityTable = entry.identityTable ?? 'workspace_metadata';
        const meta = await pgFirst<{
          workspace_id: string;
          database_id: string | null;
          plan?: string;
        }>(
          tenant,
          `SELECT workspace_id, database_id${identityTable === 'workspace_metadata' ? ', plan' : ''}
           FROM ${tenant.table(identityTable)} WHERE id = 1`,
        );
        if (
          !meta ||
          meta.workspace_id !== workspaceId ||
          (meta.plan !== undefined && meta.plan !== 'free') ||
          (meta.database_id !== null && meta.database_id !== entry.sourceDatabaseId)
        ) {
          throw new Error('Tenant database identity mismatch');
        }

        const tenantDeletionOrder = [
          'observations',
          'check_runs',
          'network_diagnostics',
          'notification_deliveries',
          'monitor_notification_services',
          'monitor_notification_state',
          'status_page_monitors',
          'status_page_groups',
          'status_pages',
          'monitor_regions',
          'monitor_daily_uptime',
          'notification_history',
          'monitors',
          'notification_services',
          'badges',
          'sessions',
          'admins',
          'jobs',
          'report_publications',
          'report_cache_revisions',
          'report_latency_changes',
          'monitor_report_refresh',
          'monitor_latency_hourly',
          'monitor_latency_dirty',
          'monitor_latency_coverage',
        ];
        for (const tbl of tenantDeletionOrder) {
          if (entry.tables.includes(tbl)) {
            await pgRun(tenant, `DELETE FROM ${tenant.table(tbl)}`);
          }
        }
      }
    }

    try {
      await pgRun(
        tx,
        `UPDATE ${tx.table('postgres_tenant_registry')} SET status = 'deleting'
         WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
    } catch {
      // Ignored if table not in scope
    }

    try {
      await pgRun(
        tx,
        `UPDATE ${tx.table('tenant_slots')} SET status = 'deleting'
         WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
    } catch {
      // Ignored if table not in scope
    }

    await pgRun(tx, `DELETE FROM ${tx.table('memberships')} WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    await pgRun(tx, `DELETE FROM ${tx.table('workspace_invitations')} WHERE workspace_id = $1`, [
      workspaceId,
    ]);

    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_usage_daily')}
         (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
       SELECT '__deleted__', day, checks, rows_read, rows_written, 0, $1
       FROM ${tx.table('workspace_usage_daily')} WHERE workspace_id = $2
       ON CONFLICT (workspace_id, day) DO UPDATE SET
         checks = ${tx.table('workspace_usage_daily')}.checks + excluded.checks,
         rows_read = ${tx.table('workspace_usage_daily')}.rows_read + excluded.rows_read,
         rows_written = ${tx.table('workspace_usage_daily')}.rows_written + excluded.rows_written,
         updated_at = excluded.updated_at`,
      [timestamp, workspaceId],
    );
    await pgRun(
      tx,
      `DELETE FROM ${tx.table('workspace_usage_daily')} WHERE workspace_id = $1`,
      [workspaceId],
    );
    await pgRun(tx, `DELETE FROM ${tx.table('dispatch_outbox')} WHERE workspace_id = $1`, [
      workspaceId,
    ]);

    await pgRun(
      tx,
      `UPDATE ${tx.table('workspaces')}
       SET state = 'deleted', name = 'Deleted workspace', last_seen_at = NULL,
           updated_at = $1, execution_lease_token = NULL, execution_lease_until = NULL
       WHERE id = $2 AND state = 'deleting'
         AND (execution_lease_until IS NULL OR execution_lease_until <= $3)`,
      [timestamp, workspaceId, timestamp],
    );

    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, 'workspace_deleted', $3, $4, '{}')`,
      [randomToken(16), workspaceId, workspace.owner_did, timestamp],
    );

    return true;
  });
}

async function purgeReports(reports: R2Bucket, workspaceId: string): Promise<boolean> {
  const tenant = tenantReportsBucket(reports, workspaceId);
  for (let pass = 0; pass < 3; pass += 1) {
    const objects = await tenant.list({ limit: 1000 });
    if (objects.objects.length === 0) return true;
    await tenant.delete(objects.objects.map((object) => object.key));
    if (!objects.truncated) return true;
  }
  return false;
}
