import { describe, expect, it } from 'vitest';
import {
  CONTROL_TABLES,
  TENANT_TABLES,
  getMigrationFilesForProfile,
  loadMigrationsForProfile,
} from './plan.js';
import { createPostgresTestDatabase } from '../../testing/postgres.js';
import { applyPostgresMigrations } from '../migrate.js';

describe('PostgreSQL 18 Migrations Plan & Assets', () => {
  it('defines the exact table counts required', () => {
    // 25 historical control tables + 1 postgres_tenant_registry
    expect(CONTROL_TABLES).toHaveLength(26);
    // 27 tenant tables
    expect(TENANT_TABLES).toHaveLength(27);
  });

  it('loads control migrations with distinct IDs and schema tokens', async () => {
    const files = getMigrationFilesForProfile('control');
    expect(files).toHaveLength(9);

    const migrations = await loadMigrationsForProfile('control');
    expect(migrations).toHaveLength(9);

    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const migration of migrations) {
      expect(migration.sql).toContain('{{schema}}');
    }
  });

  it('loads hosted tenant migrations with distinct IDs (including two 0013 files)', async () => {
    const files = getMigrationFilesForProfile('hosted');
    expect(files).toHaveLength(18);

    const migrations = await loadMigrationsForProfile('hosted');
    expect(migrations).toHaveLength(18);

    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(ids).toContain('0013_free_workspace.sql');
    expect(ids).toContain('0013_retire_report_latency_changefeed.sql');

    for (const migration of migrations) {
      expect(migration.sql).toContain('{{schema}}');
    }
  });

  it('loads legacy import tenant migrations without hosted quotas', async () => {
    const files = getMigrationFilesForProfile('legacy');
    expect(files).toHaveLength(16);

    const migrations = await loadMigrationsForProfile('legacy');
    expect(migrations).toHaveLength(16);

    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(ids).toContain('0013_staging_identity.sql');
    expect(ids).not.toContain('0013_free_workspace.sql');
    expect(ids).not.toContain('0015_workspace_product_limits.sql');
    expect(ids).not.toContain('0016_product_tiers.sql');
  });

  it('loads predata and postdata import trigger management scripts', async () => {
    const predata = await loadMigrationsForProfile('predata');
    expect(predata).toHaveLength(1);
    expect(predata[0]?.sql).toContain('DISABLE TRIGGER');

    const postdata = await loadMigrationsForProfile('postdata');
    expect(postdata).toHaveLength(1);
    expect(postdata[0]?.sql).toContain('ENABLE ALWAYS');
  });

  it('verifies that all control and tenant tables are defined in SQL assets', async () => {
    const controlMigrations = await loadMigrationsForProfile('control');
    const controlSql = controlMigrations.map((m) => m.sql).join('\n');

    for (const table of CONTROL_TABLES) {
      expect(
        controlSql.toLowerCase().includes(`create table if not exists {{schema}}.${table}`) ||
          controlSql.toLowerCase().includes(`create table {{schema}}.${table}`),
      ).toBe(true);
    }

    const tenantMigrations = await loadMigrationsForProfile('hosted');
    const tenantSql = tenantMigrations.map((m) => m.sql).join('\n');

    for (const table of TENANT_TABLES) {
      expect(
        tenantSql.toLowerCase().includes(`create table if not exists {{schema}}.${table}`) ||
          tenantSql.toLowerCase().includes(`create table {{schema}}.${table}`),
      ).toBe(true);
    }
  });

  const testAdminUrl = process.env.POSTGRES_TEST_ADMIN_URL;
  if (!testAdminUrl) {
    it.skip('skips live PostgreSQL execution when POSTGRES_TEST_ADMIN_URL is not set', () => {});
  } else {
    it('applies control migrations against live PostgreSQL', async () => {
      const migrations = await loadMigrationsForProfile('control');
      const testDb = await createPostgresTestDatabase({
        adminConnectionString: testAdminUrl,
        migrations,
        profile: 'control',
      });
      try {
        const { rows } = await testDb.db.query(
          `SELECT count(*)::int as count FROM information_schema.tables WHERE table_schema = $1`,
          [testDb.schema],
        );
        // Includes 26 tables + _postgres_migrations
        expect(rows[0]?.count).toBeGreaterThanOrEqual(26);
      } finally {
        await testDb.close();
      }
    }, 120_000);

    it('applies hosted tenant migrations against live PostgreSQL', async () => {
      const migrations = await loadMigrationsForProfile('hosted');
      const testDb = await createPostgresTestDatabase({
        adminConnectionString: testAdminUrl,
        migrations,
        profile: 'full-hosted',
      });
      try {
        const { rows } = await testDb.db.query(
          `SELECT count(*)::int as count FROM information_schema.tables WHERE table_schema = $1`,
          [testDb.schema],
        );
        // Includes 27 tenant tables + _postgres_migrations
        expect(rows[0]?.count).toBeGreaterThanOrEqual(27);
      } finally {
        await testDb.close();
      }
    }, 120_000);

    it('defaults existing status pages when adding the font column', async () => {
      const migrations = await loadMigrationsForProfile('hosted');
      const previous = migrations.filter((migration) => migration.id !== '0017_status_page_font_family.sql');
      const testDb = await createPostgresTestDatabase({
        adminConnectionString: testAdminUrl,
        migrations: previous,
        profile: 'full-hosted',
        tables: ['status_pages'],
      });
      try {
        await testDb.adminDb.query(
          `INSERT INTO ${testDb.adminDb.table('status_pages')} (id, title) VALUES ('existing', 'Existing page')`,
        );
        await applyPostgresMigrations(testDb.adminDb, migrations, 'full-hosted');
        const { rows } = await testDb.adminDb.query<{ font_family: string }>(
          `SELECT font_family FROM ${testDb.adminDb.table('status_pages')} WHERE id = 'existing'`,
        );
        expect(rows[0]?.font_family).toBe('josefin-sans');
      } finally {
        await testDb.close();
      }
    }, 120_000);
  }
});
