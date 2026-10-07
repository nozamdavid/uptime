import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import {
  openPostgresDatabase,
  quotePostgresIdentifier,
  type PostgresDatabase,
} from '../postgres/database.js';
import { applyPostgresMigrations, type PostgresMigration } from '../postgres/migrate.js';

export async function loadPostgresMigrations(directory: URL): Promise<PostgresMigration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (id) => ({ id, sql: await readFile(new URL(id, directory), 'utf8') })),
  );
}

export interface PostgresTestOptions {
  readonly adminConnectionString?: string;
  readonly migrations?: readonly PostgresMigration[];
  readonly profile?: string;
  readonly tables?: readonly string[];
}

export interface PostgresTestDatabase {
  readonly db: PostgresDatabase;
  readonly adminDb: PostgresDatabase;
  readonly schema: string;
  openConnection(): Promise<PostgresDatabase>;
  close(): Promise<void>;
}

/** Requires an explicit disposable test database admin URL. Never reads worker credentials. */
export async function createPostgresTestDatabase(
  options: PostgresTestOptions = {},
): Promise<PostgresTestDatabase> {
  const connectionString = options.adminConnectionString ?? process.env.POSTGRES_TEST_ADMIN_URL;
  if (!connectionString)
    throw new Error('POSTGRES_TEST_ADMIN_URL is required for native PostgreSQL tests');
  const schema = `uptime_test_${randomUUID().replaceAll('-', '')}`;
  const role = `uptime_test_role_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const workerUrl = new URL(connectionString);
  workerUrl.username = role;
  workerUrl.password = password;
  const adminDb = await openPostgresDatabase({
    connectionString,
    schema,
    tables: options.tables ?? [],
  });
  let db: PostgresDatabase | undefined;
  let created = false;
  let roleCreated = false;
  let databaseName: string | undefined;
  let closed = false;
  const additionalConnections: PostgresDatabase[] = [];
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await db?.close();
      await Promise.all(additionalConnections.map((connection) => connection.close()));
      if (created) await adminDb.query(`DROP SCHEMA ${quotePostgresIdentifier(schema)} CASCADE`);
      if (roleCreated && databaseName) {
        await adminDb.transaction(async (tx) => {
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('uptime:test-database-grants', 0))",
          );
          await tx.query(
            `REVOKE CONNECT ON DATABASE ${quotePostgresIdentifier(databaseName!)} FROM ${quotePostgresIdentifier(role)}`,
          );
        });
      }
      if (roleCreated) await adminDb.query(`DROP ROLE ${quotePostgresIdentifier(role)}`);
    } finally {
      await adminDb.close();
    }
  }
  try {
    await adminDb.query(`CREATE SCHEMA ${quotePostgresIdentifier(schema)}`);
    created = true;
    if (options.migrations)
      await applyPostgresMigrations(adminDb, options.migrations, options.profile ?? 'full-hosted');
    // Generated UUID passwords contain no SQL metacharacters. CREATE ROLE cannot bind parameters.
    await adminDb.query(`CREATE ROLE ${quotePostgresIdentifier(role)} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    roleCreated = true;
    const database = await adminDb.query<{ name: string }>('SELECT current_database() AS name');
    databaseName = database.rows[0]?.name;
    if (!databaseName) throw new Error('PostgreSQL test database identity is unavailable');
    await adminDb.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('uptime:test-database-grants', 0))",
      );
      await tx.query(
        `GRANT CONNECT ON DATABASE ${quotePostgresIdentifier(databaseName!)} TO ${quotePostgresIdentifier(role)}`,
      );
    });
    await adminDb.query(
      `GRANT USAGE ON SCHEMA ${quotePostgresIdentifier(schema)} TO ${quotePostgresIdentifier(role)}`,
    );
    await adminDb.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotePostgresIdentifier(schema)} TO ${quotePostgresIdentifier(role)}`,
    );
    await adminDb.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quotePostgresIdentifier(schema)} TO ${quotePostgresIdentifier(role)}`,
    );
    if (options.migrations) {
      await adminDb.query(
        `REVOKE ALL ON ${quotePostgresIdentifier(schema)}."_postgres_migrations" FROM ${quotePostgresIdentifier(role)}`,
      );
    }
    db = await openPostgresDatabase({
      connectionString: workerUrl.toString(),
      schema,
      tables: options.tables ?? [],
    });
    return {
      db,
      adminDb,
      schema,
      close,
      async openConnection() {
        if (closed) throw new Error('PostgreSQL test database is closed');
        const connection = await openPostgresDatabase({
          connectionString: workerUrl.toString(),
          schema,
          tables: options.tables ?? [],
        });
        additionalConnections.push(connection);
        return connection;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
