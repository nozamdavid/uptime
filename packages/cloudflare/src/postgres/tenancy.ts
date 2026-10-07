import { scopePostgresDatabase, type Database, type DatabaseScope } from './database.js';

export interface PostgresTenantCatalogEntry extends DatabaseScope {
  readonly sourceDatabaseId: string;
  /** Historical imports retain their original singleton marker and exemptions. */
  readonly identityTable?:
    'workspace_metadata' | 'staging_workspace_identity' | 'production_workspace_identity';
}

interface RegistryRow {
  workspace_id: string;
  source_database_id: string;
  schema_name: string;
  status: string;
}

async function verifyWorkspaceIdentity(
  control: Database,
  workspaceId: string,
  catalog: readonly PostgresTenantCatalogEntry[],
  lock: boolean,
): Promise<Database> {
  if (
    new Set(catalog.map((entry) => entry.sourceDatabaseId)).size !== catalog.length ||
    new Set(catalog.map((entry) => entry.schema)).size !== catalog.length
  ) {
    throw new Error('Trusted PostgreSQL catalog must have unique source IDs and schemas');
  }
  const { rows } = await control.query<RegistryRow>(
    `SELECT workspace_id, source_database_id, schema_name, status
       FROM ${control.table('postgres_tenant_registry')} WHERE workspace_id = $1${lock ? ' FOR SHARE' : ''}`,
    [workspaceId],
  );
  const registry = rows[0];
  if (
    rows.length !== 1 ||
    !registry ||
    registry.status !== 'assigned' ||
    registry.workspace_id !== workspaceId
  ) {
    throw new Error('Workspace has no assigned PostgreSQL tenant registry identity');
  }
  const entry = catalog.find(
    (candidate) => candidate.sourceDatabaseId === registry.source_database_id,
  );
  if (!entry || registry.schema_name !== entry.schema) {
    throw new Error('PostgreSQL tenant registry identity is outside the trusted catalog');
  }
  const tenant = scopePostgresDatabase(control, entry);
  const identity = tenant.table(entry.identityTable ?? 'workspace_metadata');
  const metadata = await tenant.query<{
    workspace_id: string;
    database_id: string | null;
    marker_count: number;
  }>(
    `SELECT workspace_id, database_id, (SELECT count(*)::integer FROM ${identity}) AS marker_count
       FROM ${identity} WHERE id = 1${lock ? ' FOR NO KEY UPDATE' : ''}`,
  );
  if (
    metadata.rows.length !== 1 ||
    metadata.rows[0]?.workspace_id !== workspaceId ||
    metadata.rows[0]?.database_id !== entry.sourceDatabaseId ||
    metadata.rows[0]?.marker_count !== 1
  ) {
    throw new Error('PostgreSQL tenant metadata identity mismatch');
  }
  return tenant;
}

/** Every operation holds registry/marker locks so a pooled assignment cannot change mid-query. */
export async function resolvePostgresWorkspaceDatabase(
  control: Database,
  workspaceId: string,
  catalog: readonly PostgresTenantCatalogEntry[],
): Promise<Database> {
  const initial = await verifyWorkspaceIdentity(control, workspaceId, catalog, false);
  async function withIdentity<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return control.transaction(async (tx) => {
      const tenant = await verifyWorkspaceIdentity(tx, workspaceId, catalog, true);
      if (tenant.schema !== initial.schema)
        throw new Error('PostgreSQL workspace assignment changed');
      return callback(tenant);
    });
  }
  return {
    schema: initial.schema,
    table: (name) => initial.table(name),
    query: (sql, values) => withIdentity((tenant) => tenant.query(sql, values)),
    transaction: withIdentity,
  };
}
