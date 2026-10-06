import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PostgresMigration } from '../packages/cloudflare/src/postgres/migrate.js';
import { loadMigrationsForProfile } from '../packages/cloudflare/src/postgres/migrations/plan.js';

export interface SlotInventory {
  binding: string;
  sourceDatabaseId: string;
  schema: string;
}

export interface LedgerEntry {
  profile: string;
  id: string;
  checksum: string;
  applied_at?: string;
}

export interface MigrationPlanResult {
  schema: string;
  profile: string;
  totalCount: number;
  skippedCount: number;
  pendingCount: number;
  applied: { id: string; checksum: string }[];
  pending: PostgresMigration[];
}

export interface SchemaMigrationPlanOptions {
  schema: string;
  profile: string;
  migrations: readonly PostgresMigration[];
  existingLedger: readonly LedgerEntry[];
}

export interface GenerateSchemaMigrationSqlOptions extends SchemaMigrationPlanOptions {
  nowIso?: string;
}

export interface GenerateControlSeedSqlOptions {
  operatorDid?: string;
  operatorHandle?: string;
  hostedSlots?: readonly SlotInventory[];
  nowIso?: string;
}

export interface GenerateGrantsSqlOptions {
  schemas: readonly string[];
  workerRole?: string;
  ownerRole?: string;
}

export const HOSTED_SLOTS: SlotInventory[] = [
  {
    binding: 'TENANT_DB_000',
    sourceDatabaseId: 'ab22dbad-9f26-4194-8502-c4cb7d6d8148',
    schema: 'tenant_000',
  },
  {
    binding: 'TENANT_DB_001',
    sourceDatabaseId: 'c3afb3be-6f21-4191-a949-a40dc2589b38',
    schema: 'tenant_001',
  },
  {
    binding: 'TENANT_DB_002',
    sourceDatabaseId: '4b7efb7e-71c4-44be-9f98-350895e59c5a',
    schema: 'tenant_002',
  },
  {
    binding: 'TENANT_DB_003',
    sourceDatabaseId: '5c7dee4d-319c-42b6-b6e5-7aef3acabb66',
    schema: 'tenant_003',
  },
  {
    binding: 'TENANT_DB_004',
    sourceDatabaseId: 'fcf7d44d-ce64-4c24-936d-4e1c4c71f28b',
    schema: 'tenant_004',
  },
  {
    binding: 'TENANT_DB_005',
    sourceDatabaseId: 'df3e3d61-85f2-4cbd-bb96-4ecdb9f48c6a',
    schema: 'tenant_005',
  },
  {
    binding: 'TENANT_DB_006',
    sourceDatabaseId: 'bcde5aad-2185-4cbc-bd6d-4f5fc04e0f3b',
    schema: 'tenant_006',
  },
  {
    binding: 'TENANT_DB_007',
    sourceDatabaseId: '41309d7e-2c58-4627-a0aa-7bb77c75dba3',
    schema: 'tenant_007',
  },
  {
    binding: 'TENANT_DB_008',
    sourceDatabaseId: '9dc3938e-84fb-47b5-af6e-6e565ae14a89',
    schema: 'tenant_008',
  },
  {
    binding: 'TENANT_DB_009',
    sourceDatabaseId: '48b0a14e-9101-49e1-bfa2-c0e15ad4854b',
    schema: 'tenant_009',
  },
  {
    binding: 'STAGING_OPERATOR_DB',
    sourceDatabaseId: '2d4169f6-df50-41f5-8729-99c475e3966c',
    schema: 'operator',
  },
  {
    binding: 'STAGING_TEST_DB_001',
    sourceDatabaseId: '646b4afc-d0c0-44ee-9827-4f5b613ee757',
    schema: 'test_001',
  },
  {
    binding: 'STAGING_TEST_DB_002',
    sourceDatabaseId: '9ea6db7e-b40c-4a9e-a4dc-8e2a83d037b8',
    schema: 'test_002',
  },
];

export const OPERATOR_DID = 'did:plc:lmkzmvv6sdxntwtyxpg7fqqq';
export const OPERATOR_HANDLE = 'noz.am';

interface RuntimeCatalogSource {
  profile: string;
  sourceDatabaseId: string;
  schema: string;
}

interface RuntimeCatalog {
  sources: RuntimeCatalogSource[];
}

export function loadCatalog(): RuntimeCatalog {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const catalogPath = resolve(
    currentDir,
    '../deploy/cloudflare/staging/postgresql-runtime-catalog.json',
  );
  return JSON.parse(readFileSync(catalogPath, 'utf8')) as RuntimeCatalog;
}

export function computeMigrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Plans migration execution by comparing expected migrations against existing ledger records.
 * Follows the native PostgreSQL migration contract:
 * - Immutable profile: rejects if ledger records have a different profile.
 * - Checksum verification: rejects if an applied migration's checksum differs from expected.
 * - Skips already-applied matching migrations.
 * - Schedules unapplied migrations for execution.
 */
export function planSchemaMigrations(options: SchemaMigrationPlanOptions): MigrationPlanResult {
  const { schema, profile, migrations, existingLedger } = options;

  if (!profile || new Set(migrations.map((m) => m.id)).size !== migrations.length) {
    throw new Error(
      `Migration profile and distinct migration IDs are required (schema: ${schema})`,
    );
  }

  // Immutable profile contract
  for (const entry of existingLedger) {
    if (entry.profile !== profile) {
      throw new Error(
        `PostgreSQL schema migration profile is immutable for schema "${schema}": expected "${profile}", found "${entry.profile}"`,
      );
    }
  }

  const existingMap = new Map(existingLedger.map((row) => [row.id, row.checksum]));
  const applied: { id: string; checksum: string }[] = [];
  const pending: PostgresMigration[] = [];

  for (const migration of migrations) {
    const checksum = computeMigrationChecksum(migration.sql);
    const existingChecksum = existingMap.get(migration.id);

    if (existingChecksum !== undefined) {
      if (existingChecksum !== checksum) {
        throw new Error(
          `Applied PostgreSQL migration changed: ${migration.id} in schema "${schema}" (expected: ${checksum}, ledger: ${existingChecksum})`,
        );
      }
      applied.push({ id: migration.id, checksum });
    } else {
      pending.push(migration);
    }
  }

  return {
    schema,
    profile,
    totalCount: migrations.length,
    skippedCount: applied.length,
    pendingCount: pending.length,
    applied,
    pending,
  };
}

/**
 * Generates transactional SQL for schema migrations.
 * Guarantees:
 * - Advisory lock on schema migrations within the transaction.
 * - Schema and ledger table created if not exist.
 * - Fresh in-transaction validation of profile immutability and checksum matches via PL/pgSQL under lock.
 * - Concurrency guard ensuring pending migrations have not been applied concurrently.
 * - Only pending migrations are executed. If all migrations are already applied, ZERO DDL is executed.
 * - Updates ledger for newly applied migrations only.
 */
export function generateSchemaMigrationSql(options: GenerateSchemaMigrationSqlOptions): string {
  const plan = planSchemaMigrations(options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const escapedProfile = plan.profile.replace(/'/g, "''");
  const escapedSchema = plan.schema.replace(/'/g, "''");

  let sql = `BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('uptime:migrations:${plan.schema}', 0));

CREATE SCHEMA IF NOT EXISTS "${plan.schema}" AUTHORIZATION uptime_staging_owner;

CREATE TABLE IF NOT EXISTS "${plan.schema}"."_postgres_migrations" (
  profile TEXT NOT NULL,
  id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (profile, id)
);

DO $$
BEGIN
  -- Profile immutability check under transaction lock
  IF EXISTS (SELECT 1 FROM "${plan.schema}"."_postgres_migrations" WHERE profile <> '${escapedProfile}') THEN
    RAISE EXCEPTION 'PostgreSQL schema migration profile is immutable for schema %', '${escapedSchema}';
  END IF;
`;

  // Verify all expected applied migrations exist with matching checksums under transaction lock
  for (const m of plan.applied) {
    const escapedId = m.id.replace(/'/g, "''");
    const escapedChecksum = m.checksum.replace(/'/g, "''");
    sql += `
  IF NOT EXISTS (
    SELECT 1 FROM "${plan.schema}"."_postgres_migrations"
    WHERE profile = '${escapedProfile}' AND id = '${escapedId}' AND checksum = '${escapedChecksum}'
  ) THEN
    RAISE EXCEPTION 'Applied PostgreSQL migration changed or missing: % in schema %', '${escapedId}', '${escapedSchema}';
  END IF;
`;
  }

  // Guard against concurrent execution of pending migrations under transaction lock
  for (const m of plan.pending) {
    const escapedId = m.id.replace(/'/g, "''");
    sql += `
  IF EXISTS (
    SELECT 1 FROM "${plan.schema}"."_postgres_migrations"
    WHERE id = '${escapedId}'
  ) THEN
    RAISE EXCEPTION 'Concurrent migration detected: % already applied in schema %', '${escapedId}', '${escapedSchema}';
  END IF;
`;
  }

  sql += `END $$;\n`;

  // Execute only pending migrations
  for (const m of plan.pending) {
    const checksum = computeMigrationChecksum(m.sql);
    const substitutedSql = m.sql.replaceAll('{{schema}}', `"${plan.schema}"`);
    const escapedChecksum = checksum.replace(/'/g, "''");
    const escapedId = m.id.replace(/'/g, "''");

    sql += `
-- Migration: ${m.id}
${substitutedSql}

INSERT INTO "${plan.schema}"."_postgres_migrations" (profile, id, checksum, applied_at)
VALUES ('${escapedProfile}', '${escapedId}', '${escapedChecksum}', '${nowIso}');
`;
  }

  sql += `COMMIT;\n`;
  return sql;
}

/**
 * Generates transactional SQL for control plane seeding.
 * Guarantees:
 * - Advisory lock on control plane seed within the transaction.
 * - In-transaction fail-closed validation under lock:
 *   - Rejects if any workspace exists in control.workspaces.
 *   - Rejects if any tenant slot has an assigned workspace or non-available status.
 *   - Rejects if any tenant registry entry has an assigned workspace or non-available status.
 *   - Rejects if any catalog binding/database_id or schema_name mismatch exists.
 *   - Rejects if operator handle or DID mismatch exists, or non-operator users exist.
 * - True idempotency and slot protection:
 *   - Uses ON CONFLICT DO NOTHING for tenant slots and tenant registry.
 *   - NEVER modifies or remaps existing slots or registry entries.
 *   - Safe to rerun on empty provisioned state without corrupting or mutating state.
 */
export function generateControlSeedSql(options: GenerateControlSeedSqlOptions = {}): string {
  const operatorDid = options.operatorDid ?? OPERATOR_DID;
  const operatorHandle = options.operatorHandle ?? OPERATOR_HANDLE;
  const hostedSlots = options.hostedSlots ?? HOSTED_SLOTS;
  const nowIso = options.nowIso ?? new Date().toISOString();

  const escapedDid = operatorDid.replace(/'/g, "''");
  const escapedHandle = operatorHandle.replace(/'/g, "''");

  let sql = `BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('uptime:seed:control', 0));

DO $$
DECLARE
  v_ws_count INTEGER;
  v_slot_assigned INTEGER;
  v_reg_assigned INTEGER;
BEGIN
  -- 1. Refuse if application workspaces exist
  SELECT count(*) INTO v_ws_count FROM "control".workspaces;
  IF v_ws_count > 0 THEN
    RAISE EXCEPTION 'Bootstrap seed refusal: % existing workspaces detected in control.workspaces. Refusing to seed over existing application state.', v_ws_count;
  END IF;

  -- 2. Refuse if assigned tenant slots exist
  SELECT count(*) INTO v_slot_assigned
  FROM "control".tenant_slots
  WHERE workspace_id IS NOT NULL OR status <> 'available';
  IF v_slot_assigned > 0 THEN
    RAISE EXCEPTION 'Bootstrap seed refusal: % assigned tenant slots detected. Refusing to overwrite active slot assignments.', v_slot_assigned;
  END IF;

  -- 3. Refuse if assigned tenant registry entries exist
  SELECT count(*) INTO v_reg_assigned
  FROM "control".postgres_tenant_registry
  WHERE workspace_id IS NOT NULL OR status <> 'available';
  IF v_reg_assigned > 0 THEN
    RAISE EXCEPTION 'Bootstrap seed refusal: % assigned tenant registry entries detected. Refusing to overwrite active registry entries.', v_reg_assigned;
  END IF;

  -- 4. Check operator identity consistency
  IF EXISTS (
    SELECT 1 FROM "control".users
    WHERE handle = '${escapedHandle}' AND did <> '${escapedDid}'
  ) THEN
    RAISE EXCEPTION 'Operator mismatch: user with handle % exists with different DID', '${escapedHandle}';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "control".users
    WHERE did = '${escapedDid}' AND handle <> '${escapedHandle}'
  ) THEN
    RAISE EXCEPTION 'Operator mismatch: operator DID % exists with different handle', '${escapedDid}';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "control".users
    WHERE did <> '${escapedDid}'
  ) THEN
    RAISE EXCEPTION 'Bootstrap seed refusal: non-operator users exist in control.users';
  END IF;
`;

  // Catalog consistency checks
  for (const slot of hostedSlots) {
    const escapedBinding = slot.binding.replace(/'/g, "''");
    const escapedSourceId = slot.sourceDatabaseId.replace(/'/g, "''");
    const escapedSchema = slot.schema.replace(/'/g, "''");

    sql += `
  IF EXISTS (
    SELECT 1 FROM "control".tenant_slots
    WHERE binding_name = '${escapedBinding}' AND database_id <> '${escapedSourceId}'
  ) THEN
    RAISE EXCEPTION 'Catalog mismatch for slot %: database_id in database does not match catalog', '${escapedBinding}';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "control".postgres_tenant_registry
    WHERE source_database_id = '${escapedSourceId}' AND schema_name <> '${escapedSchema}'
  ) THEN
    RAISE EXCEPTION 'Catalog mismatch for registry %: schema_name in database does not match catalog', '${escapedSourceId}';
  END IF;
`;
  }

  sql += `END $$;\n\n`;

  // Seed operator user
  sql += `-- Operator user seed
INSERT INTO "control".users (did, handle, state, created_at, updated_at, last_seen_at)
VALUES ('${escapedDid}', '${escapedHandle}', 'active', '${nowIso}', '${nowIso}', '${nowIso}')
ON CONFLICT (did) DO UPDATE
SET handle = EXCLUDED.handle,
    state = 'active',
    updated_at = EXCLUDED.updated_at,
    last_seen_at = EXCLUDED.last_seen_at;

-- Keep admission closed
INSERT INTO "control".service_controls (id, admission_open)
VALUES (1, 0)
ON CONFLICT (id) DO UPDATE
SET admission_open = 0;

-- Keep fleet scheduling paused
INSERT INTO "control".scheduling_controls (scope, paused, reason, actor, changed_at)
VALUES ('fleet', 1, 'Initial empty staging provisioning', 'operator', '${nowIso}')
ON CONFLICT (scope) DO UPDATE
SET paused = 1,
    reason = EXCLUDED.reason,
    actor = EXCLUDED.actor,
    changed_at = EXCLUDED.changed_at;
`;

  // Seed tenant slots and registry safely without modifying or remapping existing entries
  for (const slot of hostedSlots) {
    const escapedBinding = slot.binding.replace(/'/g, "''");
    const escapedSourceId = slot.sourceDatabaseId.replace(/'/g, "''");
    const escapedSchema = slot.schema.replace(/'/g, "''");

    sql += `
-- Slot: ${slot.binding}
INSERT INTO "control".tenant_slots (binding_name, workspace_id, database_id, schema_version, status)
VALUES ('${escapedBinding}', NULL, '${escapedSourceId}', 1, 'available')
ON CONFLICT (binding_name) DO NOTHING;

INSERT INTO "control".tenant_slot_controls (binding_name, admission_enabled)
VALUES ('${escapedBinding}', 1)
ON CONFLICT (binding_name) DO NOTHING;

INSERT INTO "control".postgres_tenant_registry (source_database_id, workspace_id, schema_name, status, created_at, updated_at)
VALUES ('${escapedSourceId}', NULL, '${escapedSchema}', 'available', '${nowIso}', '${nowIso}')
ON CONFLICT (source_database_id) DO NOTHING;
`;
  }

  sql += `COMMIT;\n`;
  return sql;
}

/**
 * Generates least-privilege role grants for worker.
 * Guarantees:
 * - Grants USAGE and DML on schemas/tables.
 * - Explicitly revokes ALL on migration ledger tables across all schemas.
 * - Sets default privileges for owner on future tables and sequences.
 * - Explicitly locks down the public schema.
 */
export function generateGrantsSql(options: GenerateGrantsSqlOptions): string {
  const workerRole = options.workerRole ?? 'uptime_staging_worker';
  const ownerRole = options.ownerRole ?? 'uptime_staging_owner';

  let sql = `BEGIN;\n`;
  for (const schema of options.schemas) {
    sql += `
GRANT USAGE ON SCHEMA "${schema}" TO ${workerRole};
REVOKE CREATE ON SCHEMA "${schema}" FROM ${workerRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${workerRole};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${workerRole};
REVOKE ALL ON "${schema}"."_postgres_migrations" FROM ${workerRole};

ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA "${schema}"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${workerRole};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA "${schema}"
  GRANT USAGE, SELECT ON SEQUENCES TO ${workerRole};
`;
  }

  sql += `
-- Public schema lockdown
REVOKE ALL ON SCHEMA public FROM ${workerRole};
REVOKE CREATE ON SCHEMA public FROM ${workerRole};
COMMIT;\n`;
  return sql;
}

export function generateWorkerVerificationQueries(operatorDid: string = OPERATOR_DID): string {
  return `
SELECT count(*) AS user_count, (SELECT handle FROM "control".users WHERE did='${operatorDid}') AS op_handle FROM "control".users;
SELECT admission_open FROM "control".service_controls WHERE id = 1;
SELECT scope, paused FROM "control".scheduling_controls WHERE scope = 'fleet';
SELECT count(*) AS available_slots FROM "control".tenant_slots WHERE status = 'available' AND workspace_id IS NULL;
SELECT count(*) AS available_registry FROM "control".postgres_tenant_registry WHERE status = 'available' AND workspace_id IS NULL;
SELECT count(*) AS workspace_count FROM "control".workspaces;
`;
}

export function generateTenantEmptinessQueries(
  slots: readonly SlotInventory[] = HOSTED_SLOTS,
): string {
  let sql = '';
  for (const slot of slots) {
    sql += `SELECT '${slot.schema}' AS schema, (SELECT count(*) FROM "${slot.schema}".monitors) AS monitors, (SELECT count(*) FROM "${slot.schema}".admins) AS admins, (SELECT count(*) FROM "${slot.schema}".workspace_metadata) AS markers;\n`;
  }
  return sql;
}

export function generateLedgerCountQueries(slots: readonly SlotInventory[] = HOSTED_SLOTS): string {
  let sql = 'SELECT count(*) AS control_migrations FROM "control"."_postgres_migrations";\n';
  for (const slot of slots) {
    sql += `SELECT '${slot.schema}' AS schema, count(*) AS count FROM "${slot.schema}"."_postgres_migrations";\n`;
  }
  return sql;
}

export function generateWorkerPermissionCheckQuery(
  schemas: readonly string[] = ['control', ...HOSTED_SLOTS.map((s) => s.schema)],
): string {
  const schemaList = schemas.map((s) => `'${s}'`).join(', ');
  return `
SELECT s.schema_name,
       has_schema_privilege('uptime_staging_worker', s.schema_name, 'CREATE') AS has_create_privilege,
       has_table_privilege('uptime_staging_worker', format('%I._postgres_migrations', s.schema_name), 'SELECT') AS has_ledger_select_privilege
FROM unnest(ARRAY[${schemaList}]) AS s(schema_name);
`;
}

export function executePsqlAsOwner(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ssh',
      ['vps', 'su - postgres -c "psql -v ON_ERROR_STOP=1 -d uptime_staging"'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql (owner) exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.stdin.write('SET ROLE uptime_staging_owner;\n');
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}

export function executePsqlAsWorker(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ssh',
      [
        'vps',
        'PGPASSWORD=$(cat /root/.config/uptime-postgresql/staging-worker-password) psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U uptime_staging_worker -d uptime_staging',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql (worker) exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.stdin.write(sql);
    proc.stdin.end();
  });
}

/**
 * Reads existing ledger records for a schema.
 * Returns empty array if schema or _postgres_migrations table does not exist yet.
 */
export async function fetchSchemaLedger(schema: string): Promise<LedgerEntry[]> {
  const checkSql = `
SELECT CASE WHEN to_regclass('"${schema}"."_postgres_migrations"') IS NOT NULL
  THEN (
    SELECT coalesce(json_agg(json_build_object('profile', profile, 'id', id, 'checksum', checksum)), '[]'::json)
    FROM "${schema}"."_postgres_migrations"
  )::text
  ELSE '[]'
END AS ledger_json;
`;
  try {
    const output = await executePsqlAsOwner(`\\t\n\\a\n${checkSql}`);
    const line = output.trim().split('\n').pop()?.trim();
    if (!line || line === '[]') return [];
    return JSON.parse(line) as LedgerEntry[];
  } catch {
    return [];
  }
}

/**
 * Runs strictly read-only, non-mutating verifications.
 * Performs zero DDL or DML (no un-rolled-back table creation, no inserts/updates).
 */
export async function runVerifications(): Promise<void> {
  console.log('- Verifying Worker access to control plane...');
  const workerControlCheck = await executePsqlAsWorker(generateWorkerVerificationQueries());
  console.log('Worker control check output:\n' + workerControlCheck.trim());

  console.log('- Verifying all 13 tenant schemas are completely empty of application rows...');
  const workerTenantCheck = await executePsqlAsWorker(generateTenantEmptinessQueries());
  console.log('Tenant emptiness check output:\n' + workerTenantCheck.trim());

  console.log(
    '- Verifying Worker cannot create tables and cannot select migration ledgers (pure read-only catalog query)...',
  );
  const allSchemas = ['control', ...HOSTED_SLOTS.map((s) => s.schema)];
  const permCheckSql = `\\t\n\\a\n${generateWorkerPermissionCheckQuery(allSchemas)}`;
  const permOutput = await executePsqlAsWorker(permCheckSql);
  const rows = permOutput
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const row of rows) {
    const [schema, hasCreate, hasLedgerSelect] = row.split('|');
    if (hasCreate === 't') {
      throw new Error(`Worker unexpectedly has CREATE privilege on schema: ${schema}`);
    }
    if (hasLedgerSelect === 't') {
      throw new Error(`Worker unexpectedly has SELECT privilege on ${schema}._postgres_migrations`);
    }
  }
  console.log(
    `✓ Worker permissions strictly confined (CREATE=f, ledger SELECT=f across all ${allSchemas.length} schemas).`,
  );

  console.log('- Verifying migration ledger counts as owner...');
  const ownerLedgerCheck = await executePsqlAsOwner(generateLedgerCountQueries());
  console.log('Owner ledger counts:\n' + ownerLedgerCheck.trim());

  console.log('\n==========================================');
  console.log('VERIFICATION COMPLETE (STRICTLY READ-ONLY)!');
  console.log('==========================================');
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');

  console.log(`Verified staging operator DID: ${OPERATOR_DID} <=> @${OPERATOR_HANDLE}`);

  if (verifyOnly) {
    console.log('Running verification only (strictly read-only)...');
    await runVerifications();
    return;
  }

  console.log('1. Loading migrations for control and full-hosted profiles...');
  const controlMigrations = await loadMigrationsForProfile('control');
  const hostedMigrations = await loadMigrationsForProfile('full-hosted');
  console.log(
    `Loaded ${controlMigrations.length} control migrations and ${hostedMigrations.length} hosted migrations.`,
  );

  if (controlMigrations.length !== 9) {
    throw new Error(`Expected 9 control migrations, got ${controlMigrations.length}`);
  }
  if (hostedMigrations.length !== 17) {
    throw new Error(`Expected 17 hosted migrations, got ${hostedMigrations.length}`);
  }

  // Validate catalog mapping against HOSTED_SLOTS
  const catalog = loadCatalog();
  const hostedSchemasFromCatalog = catalog.sources.filter((s) => s.profile === 'full-hosted');
  if (hostedSchemasFromCatalog.length !== 13) {
    throw new Error(
      `Expected 13 full-hosted sources in catalog, found ${hostedSchemasFromCatalog.length}`,
    );
  }
  for (const slot of HOSTED_SLOTS) {
    const match = hostedSchemasFromCatalog.find(
      (s) => s.sourceDatabaseId === slot.sourceDatabaseId && s.schema === slot.schema,
    );
    if (!match) {
      throw new Error(`Slot ${slot.binding} (${slot.schema}) not found in runtime catalog`);
    }
  }

  console.log('2. Provisioning schemas and running migrations...');
  const allSchemasToProvision = [
    { schema: 'control', profile: 'control', migrations: controlMigrations },
    ...HOSTED_SLOTS.map((s) => ({
      schema: s.schema,
      profile: 'full-hosted',
      migrations: hostedMigrations,
    })),
  ];

  for (const item of allSchemasToProvision) {
    console.log(`- Checking schema "${item.schema}" (profile: ${item.profile})...`);
    const existingLedger = await fetchSchemaLedger(item.schema);
    const plan = planSchemaMigrations({
      schema: item.schema,
      profile: item.profile,
      migrations: item.migrations,
      existingLedger,
    });

    console.log(
      `  Plan: total ${plan.totalCount}, skipped (applied) ${plan.skippedCount}, pending ${plan.pendingCount}`,
    );

    const sql = generateSchemaMigrationSql({
      schema: item.schema,
      profile: item.profile,
      migrations: item.migrations,
      existingLedger,
    });

    await executePsqlAsOwner(sql);
    console.log(`✓ Schema "${item.schema}" migration verified/applied.`);
  }
  console.log('✓ All 14 schemas provisioned and migrated.');

  console.log('3. Seeding control plane data safely (operator, controls, slots, registry)...');
  const seedSql = generateControlSeedSql({
    operatorDid: OPERATOR_DID,
    operatorHandle: OPERATOR_HANDLE,
    hostedSlots: HOSTED_SLOTS,
  });
  await executePsqlAsOwner(seedSql);
  console.log('✓ Control plane seeded successfully.');

  console.log('4. Configuring least-privilege grants for uptime_staging_worker...');
  const allSchemas = ['control', ...HOSTED_SLOTS.map((s) => s.schema)];
  const grantSql = generateGrantsSql({ schemas: allSchemas });
  await executePsqlAsOwner(grantSql);
  console.log('✓ Least-privilege grants applied.');

  console.log('5. Running post-provisioning verifications...');
  await runVerifications();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error('Fatal error during bootstrap:', err);
    process.exit(1);
  });
}
