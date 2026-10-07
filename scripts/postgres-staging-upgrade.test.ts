import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrationsForProfile } from '../packages/cloudflare/src/postgres/migrations/plan.js';
import { computeMigrationChecksum, HOSTED_SLOTS } from './postgres-staging-bootstrap.js';
import { main } from './postgres-staging-upgrade.js';

const container = 'uptime-font-upgrade-pg18';

function psql(sql: string): string {
  const result = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    {
      input: sql,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
  return result.stdout;
}

describe('staging font upgrade on disposable PostgreSQL 18', () => {
  it('preserves populated rows and ledger, applies defaults, and reruns without DDL', async () => {
    const hosted = (await loadMigrationsForProfile('full-hosted')).filter(
      (m) => m.id !== '0017_status_page_font_family.sql',
    );
    const legacy = (await loadMigrationsForProfile('legacy-staging')).filter(
      (m) => m.id !== '0017_status_page_font_family.sql',
    );
    psql(
      'CREATE ROLE uptime_staging_owner; GRANT CREATE ON DATABASE postgres TO uptime_staging_owner;',
    );
    for (const { schema, profile, migrations } of [
      ...HOSTED_SLOTS.map(({ schema }) => ({ schema, profile: 'full-hosted', migrations: hosted })),
      { schema: 'legacy_staging', profile: 'legacy-staging', migrations: legacy },
    ]) {
      const ledgerRows = migrations
        .map((m) => `('${profile}', '${m.id}', '${computeMigrationChecksum(m.sql)}', '2026-10-01')`)
        .join(',\n');
      psql(`SET ROLE uptime_staging_owner;
CREATE SCHEMA "${schema}";
CREATE TABLE "${schema}".status_pages (id TEXT PRIMARY KEY, title TEXT NOT NULL);
INSERT INTO "${schema}".status_pages (id, title) VALUES ('existing', 'Keep me');
CREATE TABLE "${schema}"."_postgres_migrations" (profile TEXT NOT NULL, id TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (profile, id));
INSERT INTO "${schema}"."_postgres_migrations" VALUES ${ledgerRows};`);
    }

    const execute = async (sql: string) => psql(`SET ROLE uptime_staging_owner;\n${sql}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main([], execute);
      expect(
        log.mock.calls.filter(([message]) => String(message).includes('1 pending')),
      ).toHaveLength(14);
      await main(['--apply'], execute);
      for (const schema of [...HOSTED_SLOTS.map((slot) => slot.schema), 'legacy_staging']) {
        expect(
          psql(`SELECT title, font_family FROM "${schema}".status_pages WHERE id = 'existing';`),
        ).toContain('Keep me | josefin-sans');
        expect(
          psql(
            `SELECT count(*) FROM "${schema}"."_postgres_migrations" WHERE id = '0017_status_page_font_family.sql';`,
          ),
        ).toMatch(/\b1\b/);
      }
      log.mockClear();
      await main(['--apply'], execute);
      expect(
        log.mock.calls.filter(([message]) => String(message).includes('0 pending')),
      ).toHaveLength(14);
      expect(log.mock.calls.some(([message]) => String(message).includes('committed'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
