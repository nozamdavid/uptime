import { quotePostgresIdentifier, type Database } from '../postgres/database.js';
import {
  CONTROL_TABLES,
  TENANT_TABLES,
  type PostgresTenantCatalogEntry,
} from '../postgres/index.js';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './postgres.js';
import { loadMigrationsForProfile } from '../postgres/migrations/plan.js';
import { pgRun } from '../postgres/query.js';

export interface ControlTestFixture {
  readonly fixture: PostgresTestDatabase;
  readonly db: Database;
  readonly schema: string;
  close(): Promise<void>;
}

export interface TenantTestFixture {
  readonly fixture: PostgresTestDatabase;
  readonly db: Database;
  readonly schema: string;
  readonly profile: 'full-hosted' | 'legacy-staging' | 'legacy-production';
  readonly catalogEntry: PostgresTenantCatalogEntry;
  close(): Promise<void>;
}

export async function createControlFixture(): Promise<ControlTestFixture> {
  const migrations = await loadMigrationsForProfile('control');
  const fixture = await createPostgresTestDatabase({
    migrations,
    profile: 'control',
    tables: CONTROL_TABLES,
  });

  return {
    fixture,
    db: fixture.db,
    schema: fixture.schema,
    close: () => fixture.close(),
  };
}

export async function createTenantFixture(
  sourceDatabaseId: string,
  profile: 'full-hosted' | 'legacy-staging' | 'legacy-production' = 'full-hosted',
): Promise<TenantTestFixture> {
  const migrations = await loadMigrationsForProfile(profile);
  const fixture = await createPostgresTestDatabase({
    migrations,
    profile,
    tables: TENANT_TABLES,
  });
  const identityTable =
    profile === 'legacy-staging'
      ? ('staging_workspace_identity' as const)
      : profile === 'legacy-production'
        ? ('production_workspace_identity' as const)
        : ('workspace_metadata' as const);

  const catalogEntry: PostgresTenantCatalogEntry = {
    sourceDatabaseId,
    schema: fixture.schema,
    tables: TENANT_TABLES,
    identityTable,
  };

  return {
    fixture,
    db: fixture.db,
    schema: fixture.schema,
    profile,
    catalogEntry,
    close: () => fixture.close(),
  };
}

/** Grant cross-schema access in isolated test fixture environments. */
export async function grantTenantAccessToControl(
  control: ControlTestFixture,
  tenant: TenantTestFixture,
): Promise<void> {
  const { rows } = await control.db.query<{ user: string }>('SELECT current_user AS user');
  const controlRole = rows[0]?.user;
  if (!controlRole) return;

  const tenantSchema = quotePostgresIdentifier(tenant.schema);
  const roleIdentifier = quotePostgresIdentifier(controlRole);

  await tenant.fixture.adminDb.query(`GRANT USAGE ON SCHEMA ${tenantSchema} TO ${roleIdentifier}`);
  await tenant.fixture.adminDb.query(
    `GRANT ALL ON ALL TABLES IN SCHEMA ${tenantSchema} TO ${roleIdentifier}`,
  );
  await tenant.fixture.adminDb.query(
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA ${tenantSchema} TO ${roleIdentifier}`,
  );
}

export async function seedControlUserAndWorkspace(
  control: Database,
  options: {
    workspaceId: string;
    ownerDid?: string;
    handle?: string;
    workspaceName?: string;
    state?: 'active' | 'suspended' | 'deleting' | 'deleted';
    plan?: string;
    leaseUntil?: string | null;
    leaseToken?: string | null;
    timestamp?: string;
  },
): Promise<{ workspaceId: string; ownerDid: string }> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const ownerDid = options.ownerDid ?? `did:plc:${options.workspaceId.slice(0, 24).replaceAll('-', 'a')}`;
  const handle = options.handle ?? 'owner.test';
  const state = options.state ?? 'active';

  await pgRun(
    control,
    `INSERT INTO ${control.table('users')} (did, handle, state, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, 'active', $3, $3, $3)
     ON CONFLICT (did) DO NOTHING`,
    [ownerDid, handle, timestamp],
  );

  await pgRun(
    control,
    `INSERT INTO ${control.table('workspaces')}
     (id, owner_did, name, state, plan, created_at, updated_at, execution_lease_token, execution_lease_until)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       state = excluded.state,
       execution_lease_until = excluded.execution_lease_until,
       execution_lease_token = excluded.execution_lease_token`,
    [
      options.workspaceId,
      ownerDid,
      options.workspaceName ?? 'Workspace',
      state,
      options.plan ?? 'free',
      timestamp,
      options.leaseToken ?? null,
      options.leaseUntil ?? null,
    ],
  );

  await pgRun(
    control,
    `INSERT INTO ${control.table('memberships')} (workspace_id, did, role, created_at)
     VALUES ($1, $2, 'owner', $3)
     ON CONFLICT (workspace_id, did) DO NOTHING`,
    [options.workspaceId, ownerDid, timestamp],
  );

  return { workspaceId: options.workspaceId, ownerDid };
}

export async function registerTenantSource(
  control: Database,
  options: {
    sourceDatabaseId: string;
    workspaceId: string | null;
    schemaName: string;
    status?: 'available' | 'assigned' | 'quarantined' | 'deleting';
  },
): Promise<void> {
  await pgRun(
    control,
    `INSERT INTO ${control.table('postgres_tenant_registry')}
     (source_database_id, workspace_id, schema_name, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_database_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       status = excluded.status`,
    [
      options.sourceDatabaseId,
      options.workspaceId,
      options.schemaName,
      options.status ?? (options.workspaceId ? 'assigned' : 'available'),
    ],
  );
}

export async function seedTenantIdentity(
  tenant: Database,
  options: {
    workspaceId: string;
    sourceDatabaseId: string;
    profile?: 'full-hosted' | 'legacy-staging' | 'legacy-production';
  },
): Promise<void> {
  const profile = options.profile ?? 'full-hosted';
  const table =
    profile === 'legacy-staging'
      ? 'staging_workspace_identity'
      : profile === 'legacy-production'
        ? 'production_workspace_identity'
        : 'workspace_metadata';

  if (profile === 'full-hosted') {
    await pgRun(
      tenant,
      `INSERT INTO ${tenant.table(table)} (id, workspace_id, database_id, plan, monitor_limit, region_limit)
       VALUES (1, $1, $2, 'free', 3, 3)
       ON CONFLICT (id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         database_id = excluded.database_id`,
      [options.workspaceId, options.sourceDatabaseId],
    );
  } else {
    await pgRun(
      tenant,
      `INSERT INTO ${tenant.table(table)} (id, workspace_id, source_database_id, assigned_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         source_database_id = excluded.source_database_id`,
      [options.workspaceId, options.sourceDatabaseId],
    );
  }
}
