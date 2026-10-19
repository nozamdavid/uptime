import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  scopePostgresDatabase,
  parsePostgresRuntimeCatalog,
  resolveRuntimeSource,
  withPostgresRuntime,
  CONTROL_TABLES,
  tablesForRuntimeProfile,
  type Database,
} from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
} from '@uptime/cloudflare/testing/postgres';
import type { CoordinatorEnv } from './env.js';
import {
  budgetAllowsWork,
  claimDispatches,
  dispatchDueTenants,
  finishDispatch,
  isTenantJob,
  runTenantJob,
} from './tenant-dispatch.js';
import { FakeR2 } from './testing-r2.js';

async function createControlFixture() {
  const migrations = await loadPostgresMigrations(
    new URL('../../../packages/cloudflare/src/postgres/migrations/control/', import.meta.url),
  );
  const fixture = await createPostgresTestDatabase({
    migrations,
    profile: 'control',
    tables: [...CONTROL_TABLES, 'workspace_seat_limits'],
  });
  return { fixture, db: fixture.db, schema: fixture.schema, close: () => fixture.close() };
}

async function createTenantFixture(
  sourceDatabaseId: string,
  profile: 'full-hosted' | 'legacy-staging' = 'full-hosted',
) {
  const all = await loadPostgresMigrations(
    new URL('../../../packages/cloudflare/src/postgres/migrations/tenant/', import.meta.url),
  );
  const migrations =
    profile === 'full-hosted'
      ? all
      : all.filter(
          (migration) =>
            Number(migration.id.slice(0, 4)) <= 12 ||
            migration.id === '0013_retire_report_latency_changefeed.sql' ||
            migration.id === '0014_simplify_observation_indexes.sql',
        );
  if (profile === 'legacy-staging')
    migrations.push(
      ...(
        await loadPostgresMigrations(
          new URL('../../../packages/cloudflare/src/postgres/migrations/legacy/', import.meta.url),
        )
      ).filter((migration) => migration.id === '0013_staging_identity.sql'),
    );
  const fixture = await createPostgresTestDatabase({
    migrations,
    profile,
    tables: tablesForRuntimeProfile(profile),
  });
  return {
    fixture,
    db: fixture.db,
    schema: fixture.schema,
    catalogEntry: { sourceDatabaseId },
    close: () => fixture.close(),
  };
}

async function seedControlUserAndWorkspace(db: Database, { workspaceId }: { workspaceId: string }) {
  const did = `did:plc:${workspaceId}`;
  const timestamp = now.toISOString();
  await db.query(
    `INSERT INTO ${db.table('users')} (did, handle, state, created_at, updated_at, last_seen_at)
    VALUES ($1, 'test.invalid', 'active', $2, $2, $2)`,
    [did, timestamp],
  );
  await db.query(
    `INSERT INTO ${db.table('workspaces')} (id, owner_did, name, state, plan, created_at, updated_at)
    VALUES ($1, $2, 'Runtime test', 'active', 'free', $3, $3)`,
    [workspaceId, did, timestamp],
  );
}

async function registerTenantSource(
  db: Database,
  source: { sourceDatabaseId: string; workspaceId: string; schemaName: string },
) {
  await db.query(
    `INSERT INTO ${db.table('postgres_tenant_registry')} (source_database_id, workspace_id, schema_name, status)
    VALUES ($1, $2, $3, 'assigned')`,
    [source.sourceDatabaseId, source.workspaceId, source.schemaName],
  );
}

async function seedTenantIdentity(
  db: Database,
  source: {
    sourceDatabaseId: string;
    workspaceId: string;
    profile: 'full-hosted' | 'legacy-staging';
  },
) {
  const table = db.table(
    source.profile === 'full-hosted' ? 'workspace_metadata' : 'staging_workspace_identity',
  );
  await db.query(`INSERT INTO ${table} (id, workspace_id, database_id) VALUES (1, $1, $2)`, [
    source.workspaceId,
    source.sourceDatabaseId,
  ]);
}

const workspaceId = '00000000-0000-4000-8000-000000000501';
const legacyId = '00000000-0000-4000-8000-000000000502';
const now = new Date();
let controlFixture: Awaited<ReturnType<typeof createControlFixture>>;
let hosted: Awaited<ReturnType<typeof createTenantFixture>>;
let legacy: Awaited<ReturnType<typeof createTenantFixture>>;
let control: Database;
let other: Database;
let env: CoordinatorEnv;
const queued: unknown[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  queued.length = 0;
});

describe('native runtime sessions and dispatch', () => {
  beforeAll(async () => {
    controlFixture = await createControlFixture();
    hosted = await createTenantFixture('hosted-original-source');
    legacy = await createTenantFixture('legacy-original-source', 'legacy-staging');
    // Test-only admin sessions have grants on these independently disposable schemas.
    control = controlFixture.fixture.adminDb;
    await seedControlUserAndWorkspace(control, { workspaceId });
    await seedControlUserAndWorkspace(control, { workspaceId: legacyId });
    for (const [tenant, id] of [
      [hosted, workspaceId],
      [legacy, legacyId],
    ] as const) {
      await seedTenantIdentity(tenant.db, {
        workspaceId: id,
        sourceDatabaseId: tenant.catalogEntry.sourceDatabaseId,
        profile: tenant === legacy ? 'legacy-staging' : 'full-hosted',
      });
      await registerTenantSource(control, {
        sourceDatabaseId: tenant.catalogEntry.sourceDatabaseId,
        workspaceId: id,
        schemaName: tenant.schema,
      });
    }
    const url = process.env.POSTGRES_TEST_ADMIN_URL;
    if (!url) throw new Error('Disposable test engine is required');
    env = {
      POSTGRES: { connectionString: url },
      POSTGRES_RUNTIME_CATALOG: JSON.stringify({
        controlSchema: controlFixture.schema,
        sources: [
          {
            sourceDatabaseId: hosted.catalogEntry.sourceDatabaseId,
            schema: hosted.schema,
            profile: 'full-hosted',
          },
          {
            sourceDatabaseId: legacy.catalogEntry.sourceDatabaseId,
            schema: legacy.schema,
            profile: 'legacy-staging',
          },
        ],
      }),
      POSTGRES_SOURCE_DATABASE_ID: hosted.catalogEntry.sourceDatabaseId,
      REPORTS: new FakeR2(),
      TENANT_JOBS: {
        send: async (job: unknown) => {
          queued.push(job);
        },
      },
      WORKERS_URL_DOMAIN: 'account.workers.dev',
      REGIONS_LIST: 'us-east',
      PROBE_SIGNING_SECRET: 'x'.repeat(40),
      CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
      CURRENT_BUDGET_USAGE_JSON: JSON.stringify({
        month: now.toISOString().slice(0, 7),
        observedAt: now.toISOString(),
        cloudflareCostUsd: 5,
      }),
      MONITOR_INITIAL_REPORT_WAIT_MS: '0',
    };
    other = scopePostgresDatabase(await controlFixture.fixture.openConnection(), {
      schema: controlFixture.schema,
      tables: parsePostgresRuntimeCatalog(env.POSTGRES_RUNTIME_CATALOG).control.tables,
    });
  }, 180_000);

  afterAll(async () => {
    await legacy?.close();
    await hosted?.close();
    await controlFixture?.close();
  }, 180_000);

  it('claims once on two connections, retries by generation, and fences stale acknowledgements', async () => {
    const [a, b] = await Promise.all([
      claimDispatches(control, ['hosted-original-source'], now),
      claimDispatches(other, ['hosted-original-source'], now),
    ]);
    const claims = [...a, ...b];
    expect(claims).toHaveLength(1);
    const first = claims[0]!;
    const later = new Date(now.getTime() + 61_000);
    // Retrying the pending outbox is independent of new schedule admission.
    await control.query(
      `UPDATE ${control.table('workspaces')} SET next_dispatch_at = $1 WHERE id = $2`,
      [new Date(now.getTime() + 600_000).toISOString(), workspaceId],
    );
    const [replacement] = await claimDispatches(other, ['hosted-original-source'], later);
    expect(replacement!.attempts).toBe(first.attempts + 1);
    expect(await finishDispatch(control, first, later, true)).toBe(false);
    expect(await finishDispatch(other, replacement!, later, false)).toBe(true);
    expect(await finishDispatch(control, replacement!, later, true)).toBe(false);
    const [retry] = await claimDispatches(
      control,
      ['hosted-original-source'],
      new Date(later.getTime() + 61_000),
    );
    expect(await finishDispatch(control, retry!, later, true)).toBe(true);
  }, 30_000);

  it('pauses unknown/stale usage and never uses historical D1 rows as native billing', async () => {
    expect(await budgetAllowsWork(control, now)).toBe(false);
    expect(
      await budgetAllowsWork(control, now, {
        month: now.toISOString().slice(0, 7),
        observedAt: new Date(now.getTime() - 3_600_001).toISOString(),
        cloudflareCostUsd: 0,
      }),
    ).toBe(false);
    expect(
      await budgetAllowsWork(control, now, {
        month: now.toISOString().slice(0, 7),
        observedAt: now.toISOString(),
        cloudflareCostUsd: 5,
      }),
    ).toBe(true);
    expect(
      await budgetAllowsWork(control, now, {
        month: now.toISOString().slice(0, 7),
        observedAt: now.toISOString(),
        cloudflareCostUsd: 20,
      }),
    ).toBe(false);
  });

  it('cleans expired state and dispatches sticky maintenance while paused, excluding legacy sources', async () => {
    await control.query(
      `UPDATE ${control.table('workspaces')} SET next_dispatch_at = NULL WHERE id = $1`,
      [workspaceId],
    );
    await control.query(
      `INSERT INTO ${control.table('request_budgets')} (key, window_started_at) VALUES ('old-runtime-budget', '2000-01-01T00:00:00.000Z')`,
    );
    const result = await dispatchDueTenants(
      {
        ...env,
        CURRENT_BUDGET_USAGE_JSON: '',
        controlDb: control,
        catalog: parsePostgresRuntimeCatalog(env.POSTGRES_RUNTIME_CATALOG),
      },
      new Date(now.getTime() + 1_000),
    );
    expect(result.sent).toBe(1);
    expect(queued).toEqual([expect.objectContaining({ workspaceId, maintenanceOnly: true })]);
    expect(
      (
        await control.query(
          `SELECT key FROM ${control.table('request_budgets')} WHERE key = 'old-runtime-budget'`,
        )
      ).rowCount,
    ).toBe(0);
    expect(queued.some((job) => (job as { workspaceId: string }).workspaceId === legacyId)).toBe(
      false,
    );
  });

  it('resolves hosted views and the original legacy marker', async () => {
    await withPostgresRuntime(env, async (db, catalog) => {
      const resolved = await resolveRuntimeSource(db, catalog, 'legacy-original-source');
      expect(resolved.source.identityTable).toBe('staging_workspace_identity');
      expect(resolved.schedulingPolicy).toBe('legacy');
      expect(() => resolved.db.table('workspace_metadata')).toThrow();
      await resolved.db.query(
        `SELECT workspace_id FROM ${resolved.db.table('staging_workspace_identity')} WHERE id = 1`,
      );
    });
  }, 30_000);

  it('drops imported queue work before a lease and validates all routing fields', async () => {
    await runTenantJob(
      {
        ...env,
        controlDb: control,
        catalog: parsePostgresRuntimeCatalog(env.POSTGRES_RUNTIME_CATALOG),
      },
      { workspaceId: legacyId, scheduledAt: now.toISOString() },
      now,
    );
    expect(
      (
        await control.query<{ execution_lease_token: string | null }>(
          `SELECT execution_lease_token FROM ${control.table('workspaces')} WHERE id = $1`,
          [legacyId],
        )
      ).rows[0]?.execution_lease_token,
    ).toBeNull();
    expect(
      isTenantJob({ workspaceId, scheduledAt: now.toISOString(), maintenanceOnly: 'false' }),
    ).toBe(false);
    expect(
      isTenantJob({ workspaceId, scheduledAt: now.toISOString(), routingGeneration: -1 }),
    ).toBe(false);
  });
});
