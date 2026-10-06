import { readFile } from 'node:fs/promises';
import { quotePostgresIdentifier, type Database } from './database.js';
import { getMigrationFilesForProfile, type MigrationProfile } from './migrations/plan.js';

/** Offline owner-only import. FK/check constraints remain enabled; registry assignment is separate. */
export async function importPostgresData<T>(
  db: Database,
  profile: Exclude<MigrationProfile, 'predata' | 'postdata'>,
  load: (tx: Database) => Promise<T>,
): Promise<T> {
  const files = getMigrationFilesForProfile(profile);
  const approvedTriggers = new Set<string>();
  for (const file of files) {
    const sql = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
    for (const match of sql.matchAll(/CREATE OR REPLACE TRIGGER ([a-z_]+)\s/g)) {
      if (match[1]) approvedTriggers.add(match[1]);
    }
  }
  const scripts = await Promise.all(
    ['0001_predata_disable_triggers.sql', '0002_postdata_enable_triggers.sql'].map((file) =>
      readFile(new URL(`./migrations/data-import/${file}`, import.meta.url), 'utf8'),
    ),
  );
  return db.transaction(async (tx) => {
    const ledger = `${quotePostgresIdentifier(db.schema)}."_postgres_migrations"`;
    const applied = await tx.query<{ id: string }>(`SELECT id FROM ${ledger} WHERE profile = $1`, [
      profile,
    ]);
    const ids = new Set(applied.rows.map((row) => row.id));
    if (files.some((file) => !ids.has(file.split('/').at(-1)!))) {
      throw new Error('Import profile does not match the applied schema');
    }
    const triggers = await tx.query<{ name: string }>(
      `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`,
      [db.schema],
    );
    if (triggers.rows.some((row) => !approvedTriggers.has(row.name))) {
      throw new Error('Import schema contains an unknown user trigger');
    }
    const render = (sql: string) =>
      sql
        .replaceAll('{{schema_name}}', db.schema)
        .replaceAll('{{schema}}', quotePostgresIdentifier(db.schema));
    await tx.query(render(scripts[0]!));
    const result = await load(tx);
    if (profile !== 'control') {
      const table = `${quotePostgresIdentifier(db.schema)}."report_latency_changes"`;
      await tx.query(
        `SELECT setval(pg_get_serial_sequence($1, 'sequence'),
        COALESCE(max(sequence), 1), max(sequence) IS NOT NULL) FROM ${table}`,
        [table],
      );
    }
    await tx.query(render(scripts[1]!));
    return result;
  });
}
