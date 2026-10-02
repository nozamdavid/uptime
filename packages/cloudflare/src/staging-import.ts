import type { D1Database } from './workers-types.js';

export const stagingImportedBindingName = 'STAGING_IMPORTED_DB';
export const stagingImportedDatabaseId = '3900c94a-82a0-4422-a5f8-1a56b781cea7';

/** Only the known staging import may bypass empty-pool and free-plan provisioning. */
export function isStagingImportedSlot(
  env: { readonly [key: string]: unknown },
  bindingName: string,
  databaseId: string,
): boolean {
  return (
    env.ENVIRONMENT === 'staging' &&
    bindingName === stagingImportedBindingName &&
    databaseId === stagingImportedDatabaseId
  );
}

export async function isStagingImportedWorkspace(
  env: { readonly [key: string]: unknown },
  workspaceId: string,
): Promise<boolean> {
  if (env.ENVIRONMENT !== 'staging') return false;
  const slot = await (env.CONTROL_DB as D1Database)
    .prepare('SELECT binding_name,database_id FROM tenant_slots WHERE workspace_id=? AND status=?')
    .bind(workspaceId, 'assigned')
    .first<{ binding_name: string; database_id: string }>();
  return !!slot && isStagingImportedSlot(env, slot.binding_name, slot.database_id);
}

export async function resolveStagingImportedDatabase(
  env: { readonly [key: string]: unknown },
  workspaceId: string,
): Promise<D1Database> {
  if (!(await isStagingImportedWorkspace(env, workspaceId)))
    throw new Error('Imported staging database is not assigned to this workspace');
  const db = env[stagingImportedBindingName] as D1Database | undefined;
  if (!db || typeof db.prepare !== 'function')
    throw new Error('Imported staging binding is missing');
  const identity = await db
    .prepare('SELECT workspace_id,database_id FROM staging_workspace_identity WHERE id=1')
    .first<{ workspace_id: string; database_id: string }>();
  if (identity?.workspace_id !== workspaceId || identity.database_id !== stagingImportedDatabaseId)
    throw new Error('Imported staging database identity mismatch');
  return db;
}
