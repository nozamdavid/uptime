import { beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  pgAll,
  pgFirst,
  CONTROL_TABLES,
  parsePostgresRuntimeCatalog,
  openPostgresDatabase,
  quotePostgresIdentifier,
  tablesForRuntimeProfile,
  type RuntimePostgresProfile,
  type PostgresDatabase,
  type Database,
} from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
  type PostgresTestDatabase,
} from '@uptime/cloudflare/testing/postgres';
import {
  makePostgresDatabase,
  type MonitorSeed,
  type RoundSeed,
  type ObservationSeed,
} from './testing.js';

export { pgAll as all, pgFirst as first };

export async function seedControlUser(db: Database, did: string, handle: string) {
  await db.query(
    `INSERT INTO ${db.table('users')} (did,handle,state,created_at,updated_at,last_seen_at)
    VALUES ($1,$2,'active',$3,$3,$3) ON CONFLICT (did) DO NOTHING`,
    [did, handle, new Date().toISOString()],
  );
}

export async function seedControlWorkspace(
  db: Database,
  options: { workspaceId: string; ownerDid: string; state?: string },
) {
  await db.query(
    `INSERT INTO ${db.table('workspaces')} (id,owner_did,name,state,plan,created_at,updated_at)
    VALUES ($1,$2,'Test workspace',$3,'free',$4,$4)`,
    [options.workspaceId, options.ownerDid, options.state ?? 'active', new Date().toISOString()],
  );
  await db.query(
    `INSERT INTO ${db.table('memberships')} (workspace_id,did,role,created_at)
    VALUES ($1,$2,'owner',$3)`,
    [options.workspaceId, options.ownerDid, new Date().toISOString()],
  );
}

/** Shared unprivileged role reproduces an event session with trusted control and tenant scopes. */
export async function createRuntimeFixture(
  profiles: readonly RuntimePostgresProfile[] = ['full-hosted'],
) {
  const control = await createPostgresTestDatabase({
    migrations: await loadPostgresMigrations(
      new URL('../../../packages/cloudflare/src/postgres/migrations/control/', import.meta.url),
    ),
    profile: 'control',
    tables: [...CONTROL_TABLES, 'workspace_seat_limits'],
  });
  const tenants: PostgresTestDatabase[] = [];
  const connections: PostgresDatabase[] = [];
  try {
    const role = (await control.db.query<{ role: string }>('SELECT current_user AS role')).rows[0]!
      .role;
    const password = randomUUID();
    await control.adminDb.query(
      `ALTER ROLE ${quotePostgresIdentifier(role)} PASSWORD '${password}'`,
    );
    const url = new URL(process.env.POSTGRES_TEST_ADMIN_URL!);
    url.username = role;
    url.password = password;
    for (const profile of profiles) {
      let migrations = await loadPostgresMigrations(
        new URL('../../../packages/cloudflare/src/postgres/migrations/tenant/', import.meta.url),
      );
      if (profile !== 'full-hosted') {
        migrations = migrations.filter(
          (m) =>
            Number(m.id.slice(0, 4)) <= 12 ||
            m.id === '0013_retire_report_latency_changefeed.sql' ||
            m.id === '0014_simplify_observation_indexes.sql',
        );
        migrations.push(
          ...(
            await loadPostgresMigrations(
              new URL(
                '../../../packages/cloudflare/src/postgres/migrations/legacy/',
                import.meta.url,
              ),
            )
          ).filter(
            (m) =>
              m.id ===
              (profile === 'legacy-staging'
                ? '0013_staging_identity.sql'
                : '0013_production_identity.sql'),
          ),
        );
      }
      const tenant = await createPostgresTestDatabase({
        migrations,
        profile,
        tables: tablesForRuntimeProfile(profile),
      });
      tenants.push(tenant);
      const schema = quotePostgresIdentifier(tenant.schema),
        grantee = quotePostgresIdentifier(role);
      await tenant.adminDb.query(`GRANT USAGE ON SCHEMA ${schema} TO ${grantee}`);
      await tenant.adminDb.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${grantee}`,
      );
      await tenant.adminDb.query(
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantee}`,
      );
      await tenant.adminDb.query(`REVOKE ALL ON ${schema}."_postgres_migrations" FROM ${grantee}`);
      await control.db.query(
        `INSERT INTO ${control.db.table('postgres_tenant_registry')} (source_database_id,schema_name,status)
        VALUES ($1,$2,'available')`,
        [`source-${tenants.length}`, tenant.schema],
      );
      await control.db.query(
        `INSERT INTO ${control.db.table('tenant_slots')} (binding_name,database_id,status)
        VALUES ($1,$2,'available')`,
        [`TENANT_DB_${tenants.length}`, `source-${tenants.length}`],
      );
    }
    const catalogJson = JSON.stringify({
      controlSchema: control.schema,
      sources: tenants.map((tenant, index) => ({
        sourceDatabaseId: `source-${index + 1}`,
        schema: tenant.schema,
        profile: profiles[index],
      })),
    });
    const catalog = parsePostgresRuntimeCatalog(catalogJson);
    const env = {
      POSTGRES: { connectionString: url.toString() },
      POSTGRES_RUNTIME_CATALOG: catalogJson,
    };
    return {
      control,
      tenants,
      catalog,
      env,
      async openConnection() {
        const connection = await openPostgresDatabase({
          connectionString: url.toString(),
          ...catalog.control,
        });
        connections.push(connection);
        return connection;
      },
      async assign(index: number, workspaceId: string, did: string) {
        await seedControlUser(control.db, did, 'owner.test');
        await seedControlWorkspace(control.db, { workspaceId, ownerDid: did });
        const tenant = tenants[index]!,
          source = catalog.sources[index]!;
        await tenant.db.query(
          `INSERT INTO ${tenant.db.table(source.identityTable!)} (id,workspace_id,database_id) VALUES (1,$1,$2)`,
          [workspaceId, source.sourceDatabaseId],
        );
        await control.db.query(
          `UPDATE ${control.db.table('postgres_tenant_registry')} SET workspace_id=$1,status='assigned' WHERE source_database_id=$2`,
          [workspaceId, source.sourceDatabaseId],
        );
        await control.db.query(
          `UPDATE ${control.db.table('tenant_slots')} SET workspace_id=$1,status='assigned' WHERE database_id=$2`,
          [workspaceId, source.sourceDatabaseId],
        );
      },
      async close() {
        for (const connection of connections) await connection.close();
        for (const tenant of tenants) await tenant.close();
        await control.close();
      },
    };
  } catch (error) {
    for (const tenant of tenants) await tenant.close();
    await control.close();
    throw error;
  }
}

/** One disposable legacy schema per file, with runtime DML between isolated cases. */
export function useTenantDatabase() {
  let fixture: PostgresTestDatabase;
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
  }, 180_000);
  afterEach(async () => {
    if (!fixture) return;
    await fixture.db.query(`DELETE FROM ${fixture.db.table('status_pages')}`);
    await fixture.db.query(`DELETE FROM ${fixture.db.table('monitors')}`);
    await fixture.db.query(`DELETE FROM ${fixture.db.table('notification_services')}`);
    await fixture.db.query(`DELETE FROM ${fixture.db.table('jobs')}`);
    await fixture.db.query(`DELETE FROM ${fixture.db.table('report_publications')}`);
  }, 180_000);
  afterAll(async () => {
    await fixture?.close();
  }, 180_000);
  return () => fixture;
}

export async function count(db: Database, table: string): Promise<number> {
  return (await pgFirst<{ c: number }>(db, `SELECT count(*)::int AS c FROM ${db.table(table)}`))!.c;
}

/** Batch inserts keep large fleet fixtures bounded over the forwarded test connection. */
export async function seedMonitors(
  db: Database,
  seeds: readonly (Omit<MonitorSeed, 'regions'> & {
    regions?: readonly NonNullable<MonitorSeed['regions']>[number][];
  })[],
): Promise<string[]> {
  const records = seeds.map((seed) => ({
    id: seed.id ?? crypto.randomUUID(),
    name: seed.name ?? 'Example',
    url: seed.url ?? 'https://example.com/health',
    interval_seconds: seed.intervalSeconds ?? 60,
    timeout_ms: seed.timeoutMs ?? 1_000,
    enabled: seed.enabled ?? 1,
    dns_diagnostics_enabled: seed.dnsDiagnosticsEnabled ?? 0,
    is_public: seed.isPublic ?? 0,
    public_slug: seed.publicSlug ?? null,
    outage_threshold: seed.outageThreshold ?? 3,
    recovery_threshold: seed.recoveryThreshold ?? 2,
    repeat_notification_minutes: seed.repeatNotificationMinutes ?? null,
    report_interval_seconds: seed.reportIntervalSeconds ?? 60,
    next_check_at: seed.nextCheckAt ?? '2026-09-20T10:00:00.000Z',
    updated_at: seed.updatedAt ?? '2026-09-01T00:00:00.000Z',
  }));
  await db.query(
    `INSERT INTO ${db.table('monitors')}
    (id,name,url,interval_seconds,timeout_ms,enabled,dns_diagnostics_enabled,is_public,public_slug,
     outage_threshold,recovery_threshold,repeat_notification_minutes,report_interval_seconds,next_check_at,updated_at)
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
     id text,name text,url text,interval_seconds int,timeout_ms int,enabled int,dns_diagnostics_enabled int,
     is_public int,public_slug text,outage_threshold int,recovery_threshold int,repeat_notification_minutes int,
     report_interval_seconds int,next_check_at text,updated_at text)`,
    [JSON.stringify(records)],
  );
  const regions = seeds.flatMap((seed, index) =>
    (seed.regions ?? ['us-east', 'eu-west']).map((region) => ({
      monitor_id: records[index]!.id,
      region_id: region,
    })),
  );
  await db.query(
    `INSERT INTO ${db.table('monitor_regions')} (monitor_id,region_id)
    SELECT monitor_id,region_id FROM jsonb_to_recordset($1::jsonb) AS x(monitor_id text,region_id text)`,
    [JSON.stringify(regions)],
  );
  return records.map((row) => row.id);
}

export async function seedMonitor(db: Database, seed: MonitorSeed = {}): Promise<string> {
  return (await seedMonitors(db, [seed]))[0]!;
}

export async function seedRound(db: Database, seed: RoundSeed): Promise<void> {
  const status = seed.status ?? 'pending';
  const finalizedAt =
    seed.finalizedAt === undefined
      ? status === 'pending'
        ? null
        : (seed.completedAt ?? seed.createdAt ?? seed.windowStartedAt)
      : seed.finalizedAt;
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
    (id,monitor_id,window_started_at,status,expected_region_count,expected_regions,monitor_url,
     timeout_ms,deadline_at,created_at,completed_at,finalized_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      seed.id,
      seed.monitorId,
      seed.windowStartedAt,
      status,
      seed.expectedRegionCount ?? seed.expectedRegions?.length ?? 1,
      JSON.stringify(seed.expectedRegions ?? ['us-east']),
      'https://example.com/health',
      seed.timeoutMs ?? 1_000,
      seed.deadlineAt ??
        new Date(
          Date.parse(seed.windowStartedAt) + (seed.timeoutMs ?? 1_000) + 15_000,
        ).toISOString(),
      seed.createdAt ?? seed.windowStartedAt,
      seed.completedAt ??
        (status === 'pending' ? null : (seed.finalizedAt ?? seed.windowStartedAt)),
      finalizedAt,
    ],
  );
}

export async function seedObservation(db: Database, seed: ObservationSeed): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('observations')}
    (id,check_run_id,monitor_id,region_id,scheduled_window,status,success,http_status,response_ms,
     error_code,started_at,completed_at,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (monitor_id,region_id,scheduled_window) DO NOTHING`,
    [
      seed.id ?? crypto.randomUUID(),
      seed.checkRunId,
      seed.monitorId,
      seed.regionId,
      seed.scheduledWindow,
      seed.status ?? (seed.success ? 'success' : 'http_failure'),
      seed.success ? 1 : 0,
      seed.success ? 200 : 503,
      seed.responseMs ?? null,
      seed.errorCode ?? null,
      seed.startedAt ?? seed.scheduledWindow,
      seed.completedAt ?? null,
      seed.createdAt ?? seed.scheduledWindow,
    ],
  );
}
