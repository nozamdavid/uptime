import { type Database, type PostgresMigration, pgRun } from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
  type PostgresTestDatabase,
} from '@uptime/cloudflare/testing/postgres';
import { resolveTestAdminUrl } from './test-utils.js';

export const CONTROL_TABLES = [
  'users',
  'workspaces',
  'memberships',
  'tenant_slots',
  'workspace_usage_daily',
  'service_controls',
  'workspace_invitations',
  'request_budgets',
  'workspace_events',
  'dispatch_outbox',
  'atproto_oauth_states',
  'atproto_oauth_sessions',
  'atproto_oauth_locks',
  'atproto_login_sessions',
  'tenant_slot_controls',
  'interest_signups',
  'workspace_product_limits',
  'scheduling_controls',
  'coordinator_runtime_health',
  'product_catalog_revisions',
  'product_catalog_current',
  'workspace_tier_assignments',
  'custom_status_domains',
  'workspace_billing',
  'billing_webhook_events',
  'postgres_tenant_registry',
  'workspace_seat_limits',
] as const;

let cachedControlMigrations: PostgresMigration[] | null = null;

export async function getControlMigrations(): Promise<PostgresMigration[]> {
  if (!cachedControlMigrations) {
    const migrationsDir = new URL(
      '../../../../packages/cloudflare/src/postgres/migrations/control/',
      import.meta.url,
    );
    cachedControlMigrations = await loadPostgresMigrations(migrationsDir);
  }
  return cachedControlMigrations;
}

export interface ControlTestFixture {
  readonly fixture: PostgresTestDatabase;
  readonly db: Database;
  readonly schema: string;
  openConnection(): Promise<Database>;
  close(): Promise<void>;
}

export async function createControlFixture(): Promise<ControlTestFixture> {
  const adminConnectionString = resolveTestAdminUrl();
  const migrations = await getControlMigrations();
  const fixture = await createPostgresTestDatabase({
    adminConnectionString,
    migrations,
    profile: 'control',
    tables: CONTROL_TABLES,
  });

  return {
    fixture,
    db: fixture.db,
    schema: fixture.schema,
    openConnection: () => fixture.openConnection(),
    close: () => fixture.close(),
  };
}

export async function seedControlUser(
  db: Database,
  did: string,
  handle: string,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  await pgRun(
    db,
    `INSERT INTO ${db.table('users')} (did, handle, state, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, 'active', $3, $3, $3)
     ON CONFLICT (did) DO NOTHING`,
    [did, handle, timestamp],
  );
}

export async function seedControlWorkspace(
  db: Database,
  options: {
    workspaceId: string;
    ownerDid: string;
    name?: string;
    state?: 'active' | 'suspended' | 'deleting' | 'deleted';
    plan?: string;
    timestamp?: string;
  },
): Promise<void> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const state = options.state ?? 'active';

  await pgRun(
    db,
    `INSERT INTO ${db.table('workspaces')}
     (id, owner_did, name, state, plan, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state`,
    [
      options.workspaceId,
      options.ownerDid,
      options.name ?? 'Test Workspace',
      state,
      options.plan ?? 'free',
      timestamp,
    ],
  );

  await pgRun(
    db,
    `INSERT INTO ${db.table('memberships')} (workspace_id, did, role, created_at)
     VALUES ($1, $2, 'owner', $3)
     ON CONFLICT (workspace_id, did) DO NOTHING`,
    [options.workspaceId, options.ownerDid, timestamp],
  );
}
