import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hashSessionToken, type CloudflareEnv } from '@uptime/cloudflare';
import {
  parsePostgresRuntimeCatalog,
  openPostgresDatabase,
  quotePostgresIdentifier,
  tablesForRuntimeProfile,
  type RuntimePostgresProfile,
  type PostgresDatabase,
} from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
  type PostgresTestDatabase,
} from '@uptime/cloudflare/testing/postgres';
import { createControlFixture, seedControlUser, seedControlWorkspace } from './control-fixture.js';
import { resolveTestAdminUrl } from './test-utils.js';

/** Disposable schemas and a shared no-DDL role reproduce the deployed caller boundary. */
export async function createRuntimeFixture(
  profiles: readonly RuntimePostgresProfile[] = ['full-hosted'],
) {
  const control = await createControlFixture();
  const tenants: PostgresTestDatabase[] = [];
  const connections: PostgresDatabase[] = [];
  try {
    const role = (await control.db.query<{ role: string }>('SELECT current_user AS role')).rows[0]!
      .role;
    const password = randomUUID();
    await control.fixture.adminDb.query(
      `ALTER ROLE ${quotePostgresIdentifier(role)} PASSWORD '${password}'`,
    );
    for (const profile of profiles) {
      let migrations = await loadPostgresMigrations(
        new URL('../../../../packages/cloudflare/src/postgres/migrations/tenant/', import.meta.url),
      );
      if (profile !== 'full-hosted') {
        migrations = migrations.filter(
          (migration) =>
            ![
              '0013_free_workspace.sql',
              '0015_workspace_product_limits.sql',
              '0016_product_tiers.sql',
            ].includes(migration.id),
        );
        const id =
          profile === 'legacy-staging'
            ? '0013_staging_identity.sql'
            : '0013_production_identity.sql';
        migrations.push({
          id,
          sql: await readFile(
            new URL(
              `../../../../packages/cloudflare/src/postgres/migrations/legacy/${id}`,
              import.meta.url,
            ),
            'utf8',
          ),
        });
      }
      const tenant = await createPostgresTestDatabase({
        adminConnectionString: resolveTestAdminUrl(),
        migrations,
        profile,
        tables: tablesForRuntimeProfile(profile),
      });
      tenants.push(tenant);
      const schema = quotePostgresIdentifier(tenant.schema);
      const grantee = quotePostgresIdentifier(role);
      await tenant.adminDb.query(`GRANT USAGE ON SCHEMA ${schema} TO ${grantee}`);
      await tenant.adminDb.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${grantee}`,
      );
      await tenant.adminDb.query(
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantee}`,
      );
      await tenant.adminDb.query(`REVOKE ALL ON ${schema}."_postgres_migrations" FROM ${grantee}`);
      const sourceId = `source-${tenants.length}`;
      await control.db.query(
        `INSERT INTO ${control.db.table('postgres_tenant_registry')}(source_database_id,schema_name,status) VALUES($1,$2,'available')`,
        [sourceId, tenant.schema],
      );
      await control.db.query(
        `INSERT INTO ${control.db.table('tenant_slots')}(binding_name,database_id,status) VALUES($1,$2,'available')`,
        [`TENANT_DB_${tenants.length}`, sourceId],
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
    const url = new URL(resolveTestAdminUrl());
    url.username = role;
    url.password = password;
    const env = {
      POSTGRES: { connectionString: url.toString() },
      POSTGRES_RUNTIME_CATALOG: catalogJson,
      SESSION_SECRET: 's'.repeat(32),
      OAUTH_STORAGE_SECRET: 'o'.repeat(32),
      CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
      PUBLIC_ORIGIN: 'https://api.test',
      REGIONS_LIST: 'us-east,eu-west,asia-south',
      ENVIRONMENT: 'test',
      DISABLE_RATE_LIMIT: 'true',
      CURRENT_BUDGET_USAGE_JSON: JSON.stringify({
        month: new Date().toISOString().slice(0, 7),
        observedAt: new Date().toISOString(),
        cloudflareCostUsd: 5,
      }),
    } as unknown as CloudflareEnv;
    const catalog = parsePostgresRuntimeCatalog(catalogJson);
    return {
      env,
      control,
      tenants,
      catalog,
      async openConnection() {
        const connection = await openPostgresDatabase({
          connectionString: url.toString(),
          ...catalog.control,
        });
        connections.push(connection);
        return connection;
      },
      async cookie(did: string, handle = 'owner.test') {
        const token = randomUUID();
        const now = new Date().toISOString();
        await control.db.query(
          `INSERT INTO ${control.db.table('atproto_login_sessions')}(token_hash,did,handle,expires_at,created_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$5)`,
          [
            await hashSessionToken(token, env.SESSION_SECRET!),
            did,
            handle,
            new Date(Date.now() + 3_600_000).toISOString(),
            now,
          ],
        );
        return `uptime_atproto_session=${token}`;
      },
      async assign(index: number, workspaceId: string, did: string) {
        await seedControlUser(control.db, did, 'owner.test');
        await seedControlWorkspace(control.db, { workspaceId, ownerDid: did });
        const tenant = tenants[index]!;
        const source = catalog.sources[index]!;
        await tenant.db.query(
          `INSERT INTO ${tenant.db.table(source.identityTable!)}(id,workspace_id,database_id) VALUES(1,$1,$2)`,
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
