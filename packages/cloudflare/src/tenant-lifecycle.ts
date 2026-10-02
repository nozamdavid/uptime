import { all, batch, first, run } from './db.js';
import { tenantReportsBucket } from './tenancy.js';
import { isStagingImportedWorkspace } from './staging-import.js';
import type { D1Database, R2Bucket } from './workers-types.js';

export interface TenantLifecycleEnv {
  CONTROL_DB: D1Database;
  REPORTS?: R2Bucket;
  readonly [binding: string]: unknown;
}

interface DeletingWorkspace {
  id: string;
  owner_did: string;
  state: 'deleting' | 'deleted';
  execution_lease_until: string | null;
}

interface TenantSlot {
  binding_name: string;
  database_id: string;
  status: string;
}

interface TenantMetadata {
  workspace_id: string;
  database_id: string | null;
  plan: string;
}

const protectedTenantTables = new Set(['workspace_metadata', 'd1_migrations']);
const deletionOrder = ['monitors', 'status_pages', 'notification_services', 'badges'];

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
  if (await isStagingImportedWorkspace(env, workspaceId))
    throw new Error('Imported staging data cannot be purged through workspace deletion');
  const control = env.CONTROL_DB;
  const workspace = await first<DeletingWorkspace>(
    control,
    `SELECT id, owner_did, state, execution_lease_until
       FROM workspaces WHERE id = ? AND state IN ('deleting', 'deleted') LIMIT 1`,
    [workspaceId],
  );
  if (!workspace || workspace.state === 'deleted') return true;
  if (workspace.execution_lease_until && workspace.execution_lease_until > now.toISOString()) {
    return false;
  }

  const slot = await first<TenantSlot>(
    control,
    `SELECT binding_name, database_id, status FROM tenant_slots
       WHERE workspace_id = ? AND status = 'assigned' LIMIT 1`,
    [workspaceId],
  );
  if (slot) await purgeTenantDatabase(env, workspaceId, slot);

  if (env.REPORTS && !(await purgeReports(env.REPORTS, workspaceId))) return false;

  const timestamp = now.toISOString();
  await batch(control, [
    {
      sql: `UPDATE tenant_slots SET status = 'deleting'
              WHERE workspace_id = ? AND status = 'assigned'`,
      values: [workspaceId],
    },
    { sql: 'DELETE FROM memberships WHERE workspace_id = ?', values: [workspaceId] },
    { sql: 'DELETE FROM workspace_invitations WHERE workspace_id = ?', values: [workspaceId] },
    {
      // Consumed queries remain billable after customer data is removed.
      sql: `INSERT INTO workspace_usage_daily(workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
            SELECT '__deleted__', day, checks, rows_read, rows_written, 0, ? FROM workspace_usage_daily WHERE workspace_id = ?
            ON CONFLICT(workspace_id, day) DO UPDATE SET
              checks = checks + excluded.checks, rows_read = rows_read + excluded.rows_read,
              rows_written = rows_written + excluded.rows_written, updated_at = excluded.updated_at`,
      values: [timestamp, workspaceId],
    },
    { sql: 'DELETE FROM workspace_usage_daily WHERE workspace_id = ?', values: [workspaceId] },
    { sql: 'DELETE FROM dispatch_outbox WHERE workspace_id = ?', values: [workspaceId] },
    {
      sql: `UPDATE workspaces
              SET state = 'deleted', name = 'Deleted workspace', last_seen_at = NULL,
                  updated_at = ?, execution_lease_token = NULL, execution_lease_until = NULL
            WHERE id = ? AND state = 'deleting'
              AND (execution_lease_until IS NULL OR execution_lease_until <= ?)`,
      values: [timestamp, workspaceId, timestamp],
    },
    {
      sql: `INSERT INTO workspace_events(id, workspace_id, event, actor_did, created_at, details)
              VALUES (lower(hex(randomblob(16))), ?, 'workspace_deleted', ?, ?, '{}')`,
      values: [workspaceId, workspace.owner_did, timestamp],
    },
  ]);
  return true;
}

async function purgeTenantDatabase(
  env: TenantLifecycleEnv,
  workspaceId: string,
  slot: TenantSlot,
): Promise<void> {
  const binding = env[slot.binding_name];
  if (!binding || typeof (binding as D1Database).prepare !== 'function') {
    throw new Error(`Tenant binding is unavailable: ${slot.binding_name}`);
  }
  const tenant = binding as D1Database;
  const metadata = await first<TenantMetadata>(
    tenant,
    'SELECT workspace_id, database_id, plan FROM workspace_metadata WHERE id = 1 LIMIT 1',
  );
  if (
    !metadata ||
    metadata.workspace_id !== workspaceId ||
    metadata.plan !== 'free' ||
    (metadata.database_id !== null && metadata.database_id !== slot.database_id)
  ) {
    throw new Error('Tenant database identity mismatch');
  }

  const tables = await all<{ name: string }>(
    tenant,
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'`,
  );
  const names = tables
    .map((table) => table.name)
    .filter((name) => !protectedTenantTables.has(name))
    .sort((left, right) => orderTable(left) - orderTable(right) || left.localeCompare(right));
  await batch(
    tenant,
    names.map((name) => ({ sql: `DELETE FROM ${quoteIdentifier(name)}` })),
  );
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

function orderTable(name: string): number {
  const position = deletionOrder.indexOf(name);
  return position === -1 ? deletionOrder.length : position;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
