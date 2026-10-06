import { describe, expect, it } from 'vitest';
import {
  computeMigrationChecksum,
  generateControlSeedSql,
  generateGrantsSql,
  generateLedgerCountQueries,
  generateSchemaMigrationSql,
  generateTenantEmptinessQueries,
  generateWorkerPermissionCheckQuery,
  generateWorkerVerificationQueries,
  HOSTED_SLOTS,
  loadCatalog,
  OPERATOR_DID,
  OPERATOR_HANDLE,
  planSchemaMigrations,
  type LedgerEntry,
} from './postgres-staging-bootstrap.js';

describe('postgres-staging-bootstrap safety and idempotency', () => {
  const dummyMigrations = [
    { id: '0001_initial.sql', sql: 'CREATE TABLE {{schema}}.test_table (id int);' },
    { id: '0002_add_index.sql', sql: 'CREATE INDEX test_idx ON {{schema}}.test_table (id);' },
  ];

  describe('planSchemaMigrations', () => {
    it('plans all migrations as pending when ledger is empty', () => {
      const plan = planSchemaMigrations({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger: [],
      });

      expect(plan.totalCount).toBe(2);
      expect(plan.skippedCount).toBe(0);
      expect(plan.pendingCount).toBe(2);
      expect(plan.pending.map((m) => m.id)).toEqual(['0001_initial.sql', '0002_add_index.sql']);
      expect(plan.applied).toEqual([]);
    });

    it('skips all migrations when ledger has exact matching checksums (idempotent rerun)', () => {
      const existingLedger: LedgerEntry[] = dummyMigrations.map((m) => ({
        profile: 'full-hosted',
        id: m.id,
        checksum: computeMigrationChecksum(m.sql),
      }));

      const plan = planSchemaMigrations({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger,
      });

      expect(plan.totalCount).toBe(2);
      expect(plan.skippedCount).toBe(2);
      expect(plan.pendingCount).toBe(0);
      expect(plan.pending).toEqual([]);
      expect(plan.applied.map((a) => a.id)).toEqual(['0001_initial.sql', '0002_add_index.sql']);
    });

    it('correctly handles partial migration state', () => {
      const existingLedger: LedgerEntry[] = [
        {
          profile: 'full-hosted',
          id: '0001_initial.sql',
          checksum: computeMigrationChecksum(dummyMigrations[0]!.sql),
        },
      ];

      const plan = planSchemaMigrations({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger,
      });

      expect(plan.totalCount).toBe(2);
      expect(plan.skippedCount).toBe(1);
      expect(plan.pendingCount).toBe(1);
      expect(plan.applied.map((a) => a.id)).toEqual(['0001_initial.sql']);
      expect(plan.pending.map((m) => m.id)).toEqual(['0002_add_index.sql']);
    });

    it('fails closed when an applied migration has a changed checksum', () => {
      const existingLedger: LedgerEntry[] = [
        {
          profile: 'full-hosted',
          id: '0001_initial.sql',
          checksum: 'tampered_or_stale_checksum',
        },
      ];

      expect(() =>
        planSchemaMigrations({
          schema: 'tenant_000',
          profile: 'full-hosted',
          migrations: dummyMigrations,
          existingLedger,
        }),
      ).toThrowError(/Applied PostgreSQL migration changed: 0001_initial\.sql/);
    });

    it('fails closed when ledger profile does not match expected profile (immutable profile contract)', () => {
      const existingLedger: LedgerEntry[] = [
        {
          profile: 'control',
          id: '0001_initial.sql',
          checksum: computeMigrationChecksum(dummyMigrations[0]!.sql),
        },
      ];

      expect(() =>
        planSchemaMigrations({
          schema: 'tenant_000',
          profile: 'full-hosted',
          migrations: dummyMigrations,
          existingLedger,
        }),
      ).toThrowError(/PostgreSQL schema migration profile is immutable/);
    });
  });

  describe('generateSchemaMigrationSql', () => {
    it('generates zero migration DDL when all migrations are already applied', () => {
      const existingLedger: LedgerEntry[] = dummyMigrations.map((m) => ({
        profile: 'full-hosted',
        id: m.id,
        checksum: computeMigrationChecksum(m.sql),
      }));

      const sql = generateSchemaMigrationSql({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger,
        nowIso: '2026-10-05T12:00:00.000Z',
      });

      // Must be wrapped in a single transaction with advisory lock
      expect(sql).toMatch(/^BEGIN;/);
      expect(sql).toContain(
        "SELECT pg_advisory_xact_lock(hashtextextended('uptime:migrations:tenant_000', 0));",
      );
      expect(sql).toMatch(/COMMIT;\n$/);

      // Must NOT contain DDL execution statements for migrations
      expect(sql).not.toContain('CREATE TABLE "tenant_000".test_table');
      expect(sql).not.toContain('CREATE INDEX test_idx');

      // Must contain in-transaction validation check for applied checksums under lock
      expect(sql).toContain('DO $$');
      expect(sql).toContain("RAISE EXCEPTION 'Applied PostgreSQL migration changed or missing:");
    });

    it('executes only pending migration DDL and records them in ledger', () => {
      const existingLedger: LedgerEntry[] = [
        {
          profile: 'full-hosted',
          id: '0001_initial.sql',
          checksum: computeMigrationChecksum(dummyMigrations[0]!.sql),
        },
      ];

      const sql = generateSchemaMigrationSql({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger,
        nowIso: '2026-10-05T12:00:00.000Z',
      });

      // 0001 was already applied, so its DDL must NOT be executed again
      expect(sql).not.toContain('CREATE TABLE "tenant_000".test_table');

      // 0002 is pending, so its substituted DDL must be executed
      expect(sql).toContain('CREATE INDEX test_idx ON "tenant_000".test_table');

      // Pending migration must be inserted into ledger
      expect(sql).toContain(
        `INSERT INTO "tenant_000"."_postgres_migrations" (profile, id, checksum, applied_at)`,
      );
      expect(sql).toContain("'0002_add_index.sql'");
    });

    it('includes in-transaction concurrent execution guard under lock', () => {
      const sql = generateSchemaMigrationSql({
        schema: 'tenant_000',
        profile: 'full-hosted',
        migrations: dummyMigrations,
        existingLedger: [],
        nowIso: '2026-10-05T12:00:00.000Z',
      });

      expect(sql).toContain('Concurrent migration detected:');
    });
  });

  describe('generateControlSeedSql', () => {
    const seedSql = generateControlSeedSql({
      operatorDid: OPERATOR_DID,
      operatorHandle: OPERATOR_HANDLE,
      hostedSlots: HOSTED_SLOTS,
      nowIso: '2026-10-05T12:00:00.000Z',
    });

    it('enforces single transaction with control plane advisory lock', () => {
      expect(seedSql).toMatch(/^BEGIN;/);
      expect(seedSql).toContain(
        "SELECT pg_advisory_xact_lock(hashtextextended('uptime:seed:control', 0));",
      );
      expect(seedSql).toMatch(/COMMIT;\n$/);
    });

    it('contains in-transaction refusal check for existing application workspaces', () => {
      expect(seedSql).toContain('SELECT count(*) INTO v_ws_count FROM "control".workspaces;');
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Bootstrap seed refusal: % existing workspaces detected in control.workspaces",
      );
    });

    it('contains in-transaction refusal check for active/assigned tenant slots', () => {
      expect(seedSql).toContain(
        'SELECT count(*) INTO v_slot_assigned\n  FROM "control".tenant_slots\n  WHERE workspace_id IS NOT NULL OR status <> \'available\';',
      );
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Bootstrap seed refusal: % assigned tenant slots detected",
      );
    });

    it('contains in-transaction refusal check for active/assigned tenant registry entries', () => {
      expect(seedSql).toContain(
        'SELECT count(*) INTO v_reg_assigned\n  FROM "control".postgres_tenant_registry\n  WHERE workspace_id IS NOT NULL OR status <> \'available\';',
      );
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Bootstrap seed refusal: % assigned tenant registry entries detected",
      );
    });

    it('contains in-transaction refusal checks for catalog slot/registry mismatches', () => {
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Catalog mismatch for slot %: database_id in database does not match catalog'",
      );
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Catalog mismatch for registry %: schema_name in database does not match catalog'",
      );
    });

    it('contains in-transaction refusal checks for operator mismatch', () => {
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Operator mismatch: user with handle % exists with different DID'",
      );
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Operator mismatch: operator DID % exists with different handle'",
      );
      expect(seedSql).toContain(
        "RAISE EXCEPTION 'Bootstrap seed refusal: non-operator users exist in control.users'",
      );
    });

    it('NEVER resets or remaps slots or registry entries on conflict (uses ON CONFLICT DO NOTHING)', () => {
      // Must use ON CONFLICT DO NOTHING for tenant_slots
      expect(seedSql).toContain(
        "INSERT INTO \"control\".tenant_slots (binding_name, workspace_id, database_id, schema_version, status)\nVALUES ('TENANT_DB_000', NULL, 'ab22dbad-9f26-4194-8502-c4cb7d6d8148', 1, 'available')\nON CONFLICT (binding_name) DO NOTHING;",
      );

      // Must use ON CONFLICT DO NOTHING for postgres_tenant_registry
      expect(seedSql).toContain(
        "INSERT INTO \"control\".postgres_tenant_registry (source_database_id, workspace_id, schema_name, status, created_at, updated_at)\nVALUES ('ab22dbad-9f26-4194-8502-c4cb7d6d8148', NULL, 'tenant_000', 'available', '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z')\nON CONFLICT (source_database_id) DO NOTHING;",
      );

      // Must NOT contain any DO UPDATE on tenant_slots or postgres_tenant_registry
      expect(seedSql).not.toMatch(
        /INSERT INTO "control"\.tenant_slots[\s\S]*?ON CONFLICT\s*\(binding_name\)\s*DO UPDATE/i,
      );
      expect(seedSql).not.toMatch(
        /INSERT INTO "control"\.postgres_tenant_registry[\s\S]*?ON CONFLICT\s*\(source_database_id\)\s*DO UPDATE/i,
      );
    });
  });

  describe('generateGrantsSql', () => {
    const grantSql = generateGrantsSql({
      schemas: ['control', 'tenant_000', 'operator'],
      workerRole: 'uptime_staging_worker',
      ownerRole: 'uptime_staging_owner',
    });

    it('revokes all access on _postgres_migrations from worker across all schemas', () => {
      expect(grantSql).toContain(
        'REVOKE ALL ON "control"."_postgres_migrations" FROM uptime_staging_worker;',
      );
      expect(grantSql).toContain(
        'REVOKE ALL ON "tenant_000"."_postgres_migrations" FROM uptime_staging_worker;',
      );
      expect(grantSql).toContain(
        'REVOKE ALL ON "operator"."_postgres_migrations" FROM uptime_staging_worker;',
      );
    });

    it('configures default privileges for owner to grant worker DML on future tables', () => {
      expect(grantSql).toContain(
        'ALTER DEFAULT PRIVILEGES FOR ROLE uptime_staging_owner IN SCHEMA "control"',
      );
      expect(grantSql).toContain(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uptime_staging_worker;',
      );
    });

    it('locks down public schema', () => {
      expect(grantSql).toContain('REVOKE ALL ON SCHEMA public FROM uptime_staging_worker;');
      expect(grantSql).toContain('REVOKE CREATE ON SCHEMA public FROM uptime_staging_worker;');
    });
  });

  describe('--verify-only query generation (strictly read-only)', () => {
    it('generates strictly read-only inspection queries without any DDL or DML', () => {
      const workerQueries = generateWorkerVerificationQueries();
      const tenantQueries = generateTenantEmptinessQueries();
      const ledgerQueries = generateLedgerCountQueries();
      const permQueries = generateWorkerPermissionCheckQuery();

      for (const query of [workerQueries, tenantQueries, ledgerQueries, permQueries]) {
        // No DDL or DML statements (only SELECT)
        expect(query).not.toMatch(
          /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE\s+TABLE|CREATE\s+SCHEMA)\b/im,
        );
        expect(query).toMatch(/\bSELECT\b/);
      }
    });

    it('uses catalog introspection functions (has_schema_privilege and has_table_privilege) for permission verification', () => {
      const permQueries = generateWorkerPermissionCheckQuery(['control', 'tenant_000']);
      expect(permQueries).toContain(
        "has_schema_privilege('uptime_staging_worker', s.schema_name, 'CREATE')",
      );
      expect(permQueries).toContain(
        "has_table_privilege('uptime_staging_worker', format('%I._postgres_migrations', s.schema_name), 'SELECT')",
      );
    });
  });

  describe('catalog and slot inventory consistency', () => {
    it('matches HOSTED_SLOTS with postgres-runtime-catalog.json', () => {
      const catalog = loadCatalog();
      const fullHostedSources = catalog.sources.filter((s) => s.profile === 'full-hosted');

      expect(fullHostedSources.length).toBe(13);
      expect(HOSTED_SLOTS.length).toBe(13);

      for (const slot of HOSTED_SLOTS) {
        const found = fullHostedSources.find(
          (s) => s.sourceDatabaseId === slot.sourceDatabaseId && s.schema === slot.schema,
        );
        expect(found).toBeDefined();
      }
    });
  });
});
