import type { Database } from './postgres/database.js';
import { pgFirst } from './postgres/query.js';
import {
  resolvePostgresWorkspaceDatabase,
  type PostgresTenantCatalogEntry,
} from './postgres/tenancy.js';

export const stagingImportedBindingName = 'STAGING_IMPORTED_DB';
export const stagingImportedDatabaseId = '3900c94a-82a0-4422-a5f8-1a56b781cea7';
export const productionImportedBindingName = 'PRODUCTION_IMPORTED_DB';
export const productionImportedDatabaseId = '17c009df-5b56-44cc-9776-73e0f1775b0f';

export interface ImportedDatabaseProfile {
  readonly environment: 'staging' | 'production';
  readonly bindingName: string;
  readonly databaseId: string;
  readonly identityTable: 'staging_workspace_identity' | 'production_workspace_identity';
  readonly kind: 'staging_import' | 'legacy_import';
}

const importedProfiles: readonly ImportedDatabaseProfile[] = [
  {
    environment: 'staging',
    bindingName: stagingImportedBindingName,
    databaseId: stagingImportedDatabaseId,
    identityTable: 'staging_workspace_identity',
    kind: 'staging_import',
  },
  {
    environment: 'production',
    bindingName: productionImportedBindingName,
    databaseId: productionImportedDatabaseId,
    identityTable: 'production_workspace_identity',
    kind: 'legacy_import',
  },
];

type ImportedEnv = { readonly [key: string]: unknown };

/** Return only the statically trusted import profile for this deployment. */
export function getImportedDatabaseProfile(
  env: ImportedEnv | string,
): ImportedDatabaseProfile | null {
  const envName = typeof env === 'string' ? env : (env.ENVIRONMENT as string | undefined);
  const profile = importedProfiles.find((candidate) => envName === candidate.environment);
  if (!profile) return null;
  return {
    environment: profile.environment,
    bindingName: profile.bindingName,
    databaseId: profile.databaseId,
    identityTable: profile.identityTable,
    kind: profile.kind,
  };
}

/** Match a control-plane slot against this deployment's fixed import profile. */
export function isImportedSlot(env: ImportedEnv, bindingName: string, databaseId: string): boolean {
  const profile = getImportedDatabaseProfile(env);
  const knownProfile = importedProfiles.find(
    (candidate) => candidate.bindingName === bindingName || candidate.databaseId === databaseId,
  );
  if (!knownProfile) return false;
  if (!profile || profile.bindingName !== bindingName || profile.databaseId !== databaseId)
    throw new Error('Imported database profile does not match this deployment');
  return true;
}

/** Check the assigned slot / registry and its identity marker before treating it as imported. */
export async function isImportedWorkspace(
  control: Database,
  workspaceId: string,
  catalog?: readonly PostgresTenantCatalogEntry[],
): Promise<boolean> {
  const row = await pgFirst<{ source_database_id: string; status: string }>(
    control,
    `SELECT source_database_id, status FROM ${control.table('postgres_tenant_registry')}
     WHERE workspace_id = $1 AND status = 'assigned'`,
    [workspaceId],
  );
  if (!row) {
    try {
      const slot = await pgFirst<{ binding_name: string; database_id: string }>(
        control,
        `SELECT binding_name, database_id FROM ${control.table('tenant_slots')}
         WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
      if (
        slot &&
        (slot.database_id === stagingImportedDatabaseId ||
          slot.database_id === productionImportedDatabaseId ||
          slot.binding_name === stagingImportedBindingName ||
          slot.binding_name === productionImportedBindingName)
      ) {
        return true;
      }
    } catch {
      // tenant_slots might not exist in every scope
    }
    return false;
  }
  if (
    row.source_database_id === stagingImportedDatabaseId ||
    row.source_database_id === productionImportedDatabaseId
  ) {
    return true;
  }
  if (catalog) {
    const entry = catalog.find((c) => c.sourceDatabaseId === row.source_database_id);
    if (
      entry?.identityTable === 'staging_workspace_identity' ||
      entry?.identityTable === 'production_workspace_identity'
    ) {
      return true;
    }
  }
  return false;
}

/** Resolve only an exactly assigned import whose singleton marker matches. */
export async function resolveImportedDatabase(
  control: Database,
  workspaceId: string,
  catalog: readonly PostgresTenantCatalogEntry[],
): Promise<Database> {
  if (!catalog) throw new Error('Postgres catalog is required to resolve imported database');
  const isImported = await isImportedWorkspace(control, workspaceId, catalog);
  if (!isImported) {
    throw new Error('Imported database is not assigned to this workspace');
  }
  return resolvePostgresWorkspaceDatabase(control, workspaceId, catalog);
}

/** Compatibility exports retained for callers that still name the staging profile. */
export function isStagingImportedSlot(
  env: ImportedEnv,
  bindingName: string,
  databaseId: string,
): boolean {
  return (
    isImportedSlot(env, bindingName, databaseId) &&
    getImportedDatabaseProfile(env)?.kind === 'staging_import'
  );
}

export async function isStagingImportedWorkspace(
  control: Database,
  workspaceId: string,
  catalog?: readonly PostgresTenantCatalogEntry[],
): Promise<boolean> {
  return isImportedWorkspace(control, workspaceId, catalog);
}

export async function resolveStagingImportedDatabase(
  control: Database,
  workspaceId: string,
  catalog: readonly PostgresTenantCatalogEntry[],
): Promise<Database> {
  return resolveImportedDatabase(control, workspaceId, catalog);
}
