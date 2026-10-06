import { createHash } from 'node:crypto';
import { quotePostgresIdentifier, type Database } from './database.js';

export interface PostgresMigration {
  readonly id: string;
  readonly sql: string;
}

/** Admin-only, native SQL migrations; templates substitute only a trusted schema identifier. */
export async function applyPostgresMigrations(
  db: Database,
  migrations: readonly PostgresMigration[],
  profile: string,
): Promise<void> {
  if (profile === 'predata' || profile === 'postdata') {
    throw new Error('Data import scripts require importPostgresData, not the migration ledger');
  }
  if (!profile || new Set(migrations.map((migration) => migration.id)).size !== migrations.length) {
    throw new Error('Migration profile and distinct migration IDs are required');
  }
  const schema = quotePostgresIdentifier(db.schema);
  const ledger = `${schema}."_postgres_migrations"`;
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `uptime:migrations:${db.schema}`,
    ]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
      profile TEXT NOT NULL, id TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL, PRIMARY KEY (profile, id)
    )`);
    const profiles = await tx.query<{ profile: string }>(`SELECT DISTINCT profile FROM ${ledger}`);
    if (profiles.rows.some((row) => row.profile !== profile)) {
      throw new Error('PostgreSQL schema migration profile is immutable');
    }
    const existing = await tx.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM ${ledger} WHERE profile = $1`,
      [profile],
    );
    const checksums = new Map(existing.rows.map((row) => [row.id, row.checksum]));
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = checksums.get(migration.id);
      if (previous !== undefined) {
        if (previous !== checksum)
          throw new Error(`Applied PostgreSQL migration changed: ${migration.id}`);
        continue;
      }
      // Migration files may have many statements and function bodies. pg's simple
      // protocol executes them intact; app queries still require one statement.
      const sql = migration.sql.replaceAll('{{schema}}', schema);
      await tx.query(sql);
      await tx.query(
        `INSERT INTO ${ledger} (profile, id, checksum, applied_at) VALUES ($1, $2, $3, $4)`,
        [profile, migration.id, checksum, new Date().toISOString()],
      );
    }
  });
}
