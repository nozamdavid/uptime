import {
  quotePostgresIdentifier,
  withPostgresDatabase,
  type Database,
  type DatabaseScope,
  type HyperdriveBinding,
} from './database.js';
import { resolvePostgresWorkspaceDatabase, type PostgresTenantCatalogEntry } from './tenancy.js';
import { CONTROL_TABLES, tablesForRuntimeProfile, type RuntimePostgresProfile } from './tables.js';

export interface RuntimePostgresSource extends PostgresTenantCatalogEntry {
  readonly profile: RuntimePostgresProfile;
}

export interface RuntimePostgresCatalog {
  readonly control: DatabaseScope;
  readonly sources: readonly RuntimePostgresSource[];
}

export interface PostgresRuntimeBindings {
  readonly POSTGRES?: HyperdriveBinding;
  /** Trusted deployment JSON, never request input. */
  readonly POSTGRES_RUNTIME_CATALOG?: string;
  /** Fixed physical source for a dedicated legacy coordinator/reporter. */
  readonly POSTGRES_SOURCE_DATABASE_ID?: string;
}

/** Reject ambiguous manifests before opening a client; derive all table/marker inventories. */
export function parsePostgresRuntimeCatalog(value: unknown): RuntimePostgresCatalog {
  if (typeof value !== 'string') throw new Error('POSTGRES_RUNTIME_CATALOG is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid PostgreSQL runtime catalog JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid PostgreSQL runtime catalog');
  const config = parsed as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => key !== 'controlSchema' && key !== 'sources') ||
    typeof config.controlSchema !== 'string' ||
    !Array.isArray(config.sources)
  )
    throw new Error('Invalid PostgreSQL runtime catalog shape');
  quotePostgresIdentifier(config.controlSchema);
  const ids = new Set<string>();
  const schemas = new Set<string>([config.controlSchema]);
  const sources = config.sources.map((raw: unknown): RuntimePostgresSource => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid PostgreSQL source');
    const source = raw as Record<string, unknown>;
    if (
      Object.keys(source).some((key) => !['sourceDatabaseId', 'schema', 'profile'].includes(key)) ||
      typeof source.sourceDatabaseId !== 'string' ||
      !source.sourceDatabaseId.trim() ||
      source.sourceDatabaseId.trim() !== source.sourceDatabaseId ||
      typeof source.schema !== 'string' ||
      !['full-hosted', 'legacy-staging', 'legacy-production'].includes(String(source.profile))
    )
      throw new Error('Invalid PostgreSQL source identity/profile');
    quotePostgresIdentifier(source.schema);
    if (ids.has(source.sourceDatabaseId) || schemas.has(source.schema))
      throw new Error('PostgreSQL runtime sources must have unique IDs and schemas');
    ids.add(source.sourceDatabaseId);
    schemas.add(source.schema);
    const profile = source.profile as RuntimePostgresProfile;
    return Object.freeze({
      sourceDatabaseId: source.sourceDatabaseId,
      schema: source.schema,
      profile,
      tables: Object.freeze(tablesForRuntimeProfile(profile)),
      identityTable:
        profile === 'full-hosted'
          ? 'workspace_metadata'
          : profile === 'legacy-staging'
            ? 'staging_workspace_identity'
            : 'production_workspace_identity',
    });
  });
  return Object.freeze({
    control: Object.freeze({
      schema: config.controlSchema,
      tables: Object.freeze([...CONTROL_TABLES, 'workspace_seat_limits']),
    }),
    sources: Object.freeze(sources),
  });
}

export async function withPostgresRuntime<T>(
  env: PostgresRuntimeBindings,
  callback: (control: Database, catalog: RuntimePostgresCatalog) => Promise<T>,
): Promise<T> {
  const catalog = parsePostgresRuntimeCatalog(env.POSTGRES_RUNTIME_CATALOG);
  if (!env.POSTGRES?.connectionString) throw new Error('POSTGRES Hyperdrive binding is required');
  return withPostgresDatabase(env.POSTGRES, catalog.control, (control) =>
    callback(control, catalog),
  );
}

export interface RuntimeWorkspace {
  readonly db: Database;
  readonly workspaceId: string;
  readonly source: RuntimePostgresSource;
  readonly schedulingPolicy: 'hosted' | 'legacy';
}

export async function resolveRuntimeWorkspace(
  control: Database,
  catalog: RuntimePostgresCatalog,
  workspaceId: string,
): Promise<RuntimeWorkspace> {
  const db = await resolvePostgresWorkspaceDatabase(control, workspaceId, catalog.sources);
  const source = catalog.sources.find((entry) => entry.schema === db.schema);
  if (!source) throw new Error('Resolved source is outside the runtime catalog');
  return {
    db,
    workspaceId,
    source,
    schedulingPolicy: source.profile === 'full-hosted' ? 'hosted' : 'legacy',
  };
}

/** Dedicated events route by physical source. Registry assignment remains dynamic. */
export async function resolveRuntimeSource(
  control: Database,
  catalog: RuntimePostgresCatalog,
  sourceDatabaseId: unknown,
): Promise<RuntimeWorkspace> {
  if (
    typeof sourceDatabaseId !== 'string' ||
    !catalog.sources.some((entry) => entry.sourceDatabaseId === sourceDatabaseId)
  )
    throw new Error('POSTGRES_SOURCE_DATABASE_ID must select a trusted physical source');
  const { rows } = await control.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM ${control.table('postgres_tenant_registry')}
     WHERE source_database_id = $1 AND status = 'assigned'`,
    [sourceDatabaseId],
  );
  if (rows.length !== 1 || !rows[0]?.workspace_id)
    throw new Error('Physical source is not assigned');
  const resolved = await resolveRuntimeWorkspace(control, catalog, rows[0].workspace_id);
  if (resolved.source.sourceDatabaseId !== sourceDatabaseId)
    throw new Error('Physical source assignment changed during resolution');
  return resolved;
}
